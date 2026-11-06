import { Button, Classes, Collapse, HTMLTable } from '@blueprintjs/core';
import { useState } from 'react';

import { anchorsOf } from '../lib/anchor';
import { browserLabel } from '../lib/context';
import type { Anchor, PageContext } from '../shared/types';
import { useWidget } from './context';

/** The environment captured with the thread, folded by default. */
export function ContextInfo({ context, anchor }: { context: Partial<PageContext>; anchor: Partial<Anchor> }) {
  const { t } = useWidget();
  const [open, setOpen] = useState(false);
  const errors = context.console?.filter((c) => c.level === 'error') ?? [];
  const failed = context.network ?? [];
  const problems = errors.length + failed.length;
  return (
    <div className="bugspot-context">
      <Button
        variant="minimal"
        size="small"
        icon={open ? 'chevron-down' : 'chevron-right'}
        text={problems ? `${t.context} · ${problems}` : t.context}
        intent={problems ? 'warning' : 'none'}
        onClick={() => setOpen((o) => !o)}
      />
      <Collapse isOpen={open}>
        <HTMLTable compact className="bugspot-context-table">
          <tbody>
            {context.userAgent && (
              <tr>
                <th>{t.browser}</th>
                <td>{browserLabel(context.userAgent)}</td>
              </tr>
            )}
            {context.viewport && (
              <tr>
                <th>{t.viewport}</th>
                <td>
                  {context.viewport.w}×{context.viewport.h} @{context.viewport.dpr}x
                </td>
              </tr>
            )}
            {context.appVersion && (
              <tr>
                <th>{t.version}</th>
                <td>{context.appVersion}</td>
              </tr>
            )}
            {anchorsOf(anchor)
              .filter((a) => a.selector || a.source)
              .map((a, i, all) => (
                <tr key={i}>
                  <th>{all.length > 1 ? `${t.element} ${i + 1}` : t.element}</th>
                  <td className="bugspot-code">{a.source ?? a.selector}</td>
                </tr>
              ))}
          </tbody>
        </HTMLTable>
        {errors.length > 0 && (
          <>
            <h5 className={Classes.HEADING}>{t.consoleErrors}</h5>
            <ul className="bugspot-log">
              {errors.map((e, i) => (
                <li key={i} className="bugspot-code">
                  {e.message}
                </li>
              ))}
            </ul>
          </>
        )}
        {failed.length > 0 && (
          <>
            <h5 className={Classes.HEADING}>{t.failedRequests}</h5>
            <ul className="bugspot-log">
              {failed.map((n, i) => (
                <li key={i} className="bugspot-code">
                  {n.status || 'ERR'} {n.method} {n.url}
                  {n.requestId ? ` · ${n.requestId}` : ''}
                </li>
              ))}
            </ul>
          </>
        )}
      </Collapse>
    </div>
  );
}
