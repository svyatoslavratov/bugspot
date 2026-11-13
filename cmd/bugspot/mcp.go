package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

// The MCP server speaks JSON-RPC 2.0 over stdio (one message per line) and calls the bugspot API
// with an agent token, so the agent has exactly the token's rights: it reads threads, replies and
// moves them up to "fixed"; resolving and "checked by a person" stay with people.

var mcpVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

const mcpInstructions = `bugspot holds comments people pinned to elements of a web app: what is wrong, where, with a
screenshot and the page context (browser, app version, console errors, failed requests with
X-Request-ID). Work loop: list_threads → get_thread (and get_screenshot) → set_status in_progress →
fix the code → reply with what changed and in which version → set_status fixed. People check the
result and resolve the thread; you cannot resolve or mark it checked. Threads are referred to by
number (#12) or id.` + mcpMapInstructions

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type mcpTool struct {
	Name        string         `json:"name"`
	Title       string         `json:"title"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations map[string]any `json:"annotations"`
}

type mcpContent struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
}

type mcpServer struct {
	api *client
}

var threadArg = map[string]any{"type": "string", "description": "Thread number (12 or #12) or id"}

func object(props map[string]any, required ...string) map[string]any {
	schema := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

var readOnly = map[string]any{"readOnlyHint": true, "openWorldHint": false}
var writes = map[string]any{"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false}

var mcpTools = []mcpTool{
	{
		Name: "list_threads", Title: "List threads",
		Description: "Threads with status, kind, route, author, reply count and text. By default the ones that need work: open and in_progress.",
		InputSchema: object(map[string]any{
			"status": map[string]any{"type": "array", "items": map[string]any{"type": "string",
				"enum": []string{"open", "in_progress", "fixed", "resolved", "wontfix"}}, "description": "Statuses; empty for all"},
			"route": map[string]any{"type": "string", "description": "Only this page route, e.g. /campaigns"},
			"q":     map[string]any{"type": "string", "description": "Search in text, author and route"},
			"limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100},
		}),
		Annotations: readOnly,
	},
	{
		Name: "get_thread", Title: "Read a thread",
		Description: "One thread: text, page URL and route, the element (selector, text, source location if any), captured context, status history, verification and replies.",
		InputSchema: object(map[string]any{"thread": threadArg}, "thread"),
		Annotations: readOnly,
	},
	{
		Name: "get_screenshot", Title: "Look at the screenshot",
		Description: "The screenshot attached to a thread, with the element outlined in red.",
		InputSchema: object(map[string]any{"thread": threadArg}, "thread"),
		Annotations: readOnly,
	},
	{
		Name: "reply", Title: "Reply in a thread",
		Description: "Answer the people in the thread: what you found, what you changed and in which version.",
		InputSchema: object(map[string]any{"thread": threadArg, "body": map[string]any{"type": "string", "maxLength": 10000}}, "thread", "body"),
		Annotations: writes,
	},
	{
		Name: "set_status", Title: "Move a thread",
		Description: "in_progress when you take it, fixed when the fix is deployed, wontfix with a reply explaining why, open to hand it back. Resolving is for people.",
		InputSchema: object(map[string]any{"thread": threadArg, "status": map[string]any{"type": "string",
			"enum": []string{"open", "in_progress", "fixed", "wontfix"}}}, "thread", "status"),
		Annotations: writes,
	},
	{
		Name: "summary", Title: "Count threads",
		Description: "Thread counts by status in the project, and on one route when given.",
		InputSchema: object(map[string]any{"route": map[string]any{"type": "string"}}),
		Annotations: readOnly,
	},
}

// mcp runs the server on stdin/stdout until stdin closes.
func (a *app) mcp(_ []string) error {
	api, err := a.newClient()
	if err != nil {
		return err
	}
	return (&mcpServer{api: api}).serve(a.stdin, a.stdout)
}

func (s *mcpServer) serve(in io.Reader, out io.Writer) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 1<<20), 16<<20)
	enc := json.NewEncoder(out)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var req rpcRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			if err := enc.Encode(rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{Code: -32700, Message: "parse error"}}); err != nil {
				return err
			}
			continue
		}
		res := s.handle(req)
		if res == nil {
			continue // a notification
		}
		if err := enc.Encode(res); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func (s *mcpServer) handle(req rpcRequest) *rpcResponse {
	if len(req.ID) == 0 {
		return nil
	}
	res := &rpcResponse{JSONRPC: "2.0", ID: req.ID}
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &p)
		version := mcpVersions[0]
		if slices.Contains(mcpVersions, p.ProtocolVersion) {
			version = p.ProtocolVersion
		}
		res.Result = map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "bugspot", "title": "bugspot", "version": version},
			"instructions":    mcpInstructions,
		}
	case "ping":
		res.Result = map[string]any{}
	case "tools/list":
		res.Result = map[string]any{"tools": append(slices.Clone(mcpTools), mapTools...)}
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			res.Error = &rpcError{Code: -32602, Message: "invalid params"}
			return res
		}
		content, err := s.call(p.Name, p.Arguments)
		if errors.Is(err, errUnknownTool) {
			res.Error = &rpcError{Code: -32602, Message: err.Error()}
			return res
		}
		if err != nil {
			// Tool failures go back to the model as results, so it can react.
			res.Result = map[string]any{"content": []mcpContent{{Type: "text", Text: err.Error()}}, "isError": true}
			return res
		}
		res.Result = map[string]any{"content": content}
	default:
		res.Error = &rpcError{Code: -32601, Message: "method not found: " + req.Method}
	}
	return res
}

var errUnknownTool = errors.New("unknown tool")

type toolArgs struct {
	Thread string   `json:"thread"`
	Status any      `json:"status"`
	Route  string   `json:"route"`
	Q      string   `json:"q"`
	Limit  int      `json:"limit"`
	Body   string   `json:"body"`
	Kinds  []string `json:"-"`
}

func textJSON(raw []byte) []mcpContent { return []mcpContent{{Type: "text", Text: string(raw)}} }

func (s *mcpServer) call(name string, raw json.RawMessage) ([]mcpContent, error) {
	if len(raw) == 0 {
		raw = json.RawMessage("{}")
	}
	if content, handled, err := s.callMap(name, raw); handled {
		return content, err
	}
	var a toolArgs
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, fmt.Errorf("arguments: %w", err)
		}
	}
	need := func() error {
		if strings.TrimSpace(a.Thread) == "" {
			return errors.New("thread is required")
		}
		return nil
	}
	var out []byte
	switch name {
	case "list_threads":
		q := url.Values{"limit": {"50"}, "status": {"open,in_progress"}}
		switch st := a.Status.(type) {
		case []any:
			parts := make([]string, 0, len(st))
			for _, v := range st {
				parts = append(parts, fmt.Sprint(v))
			}
			q.Set("status", strings.Join(parts, ","))
		case string:
			q.Set("status", st)
		}
		if a.Route != "" {
			q.Set("route", a.Route)
		}
		if a.Q != "" {
			q.Set("q", a.Q)
		}
		if a.Limit > 0 {
			q.Set("limit", strconv.Itoa(min(a.Limit, 100)))
		}
		if err := s.api.do(http.MethodGet, "api/v1/threads?"+q.Encode(), nil, &out); err != nil {
			return nil, err
		}
		return compactList(out)
	case "get_thread":
		if err := need(); err != nil {
			return nil, err
		}
		if err := s.api.do(http.MethodGet, "api/v1/threads/"+ref(a.Thread), nil, &out); err != nil {
			return nil, err
		}
		return textJSON(out), nil
	case "get_screenshot":
		if err := need(); err != nil {
			return nil, err
		}
		if err := s.api.do(http.MethodGet, "api/v1/threads/"+ref(a.Thread)+"/screenshot", nil, &out); err != nil {
			return nil, err
		}
		return []mcpContent{{Type: "image", Data: base64.StdEncoding.EncodeToString(out), MimeType: http.DetectContentType(out)}}, nil
	case "reply":
		if err := need(); err != nil {
			return nil, err
		}
		if err := s.api.do(http.MethodPost, "api/v1/threads/"+ref(a.Thread)+"/replies", map[string]string{"body": a.Body}, &out); err != nil {
			return nil, err
		}
		return textJSON(out), nil
	case "set_status":
		if err := need(); err != nil {
			return nil, err
		}
		status, _ := a.Status.(string)
		if err := s.api.do(http.MethodPatch, "api/v1/threads/"+ref(a.Thread), map[string]string{"status": status}, &out); err != nil {
			return nil, err
		}
		return compactThread(out)
	case "summary":
		path := "api/v1/threads/summary"
		if a.Route != "" {
			path += "?" + url.Values{"route": {a.Route}}.Encode()
		}
		if err := s.api.do(http.MethodGet, path, nil, &out); err != nil {
			return nil, err
		}
		return textJSON(out), nil
	}
	return nil, fmt.Errorf("%w %q", errUnknownTool, name)
}

// compact keeps what an agent needs to choose a thread, without anchors and captured context.
type compact struct {
	Number        int    `json:"number"`
	ID            string `json:"id"`
	Status        string `json:"status"`
	Verified      bool   `json:"verified"`
	Kind          string `json:"kind"`
	Route         string `json:"route"`
	Author        string `json:"author"`
	Body          string `json:"body"`
	ReplyCount    int    `json:"replyCount"`
	HasScreenshot bool   `json:"hasScreenshot"`
	UpdatedAt     string `json:"updatedAt"`
}

func toCompact(t cliThread) compact {
	return compact{Number: t.Number, ID: t.ID, Status: t.Status, Verified: t.Verified, Kind: t.Kind, Route: t.Route,
		Author: t.Author.Name, Body: t.Body, ReplyCount: t.ReplyCount, HasScreenshot: t.HasScreenshot,
		UpdatedAt: t.UpdatedAt.UTC().Format("2006-01-02T15:04:05Z")}
}

func compactList(raw []byte) ([]mcpContent, error) {
	var page struct {
		Data []cliThread
		Meta struct{ Total int }
	}
	if err := json.Unmarshal(raw, &page); err != nil {
		return nil, err
	}
	list := make([]compact, len(page.Data))
	for i, t := range page.Data {
		list[i] = toCompact(t)
	}
	out, err := json.Marshal(map[string]any{"threads": list, "total": page.Meta.Total})
	return textJSON(out), err
}

func compactThread(raw []byte) ([]mcpContent, error) {
	var t cliThread
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, err
	}
	out, err := json.Marshal(toCompact(t))
	return textJSON(out), err
}
