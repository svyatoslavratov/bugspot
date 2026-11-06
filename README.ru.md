# bugspot

[![CI](https://github.com/svyatoslavratov/bugspot/actions/workflows/ci.yml/badge.svg)](https://github.com/svyatoslavratov/bugspot/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/svyatoslavratov/bugspot?sort=semver)](https://github.com/svyatoslavratov/bugspot/releases)
[![Go Reference](https://pkg.go.dev/badge/github.com/svyatoslavratov/bugspot.svg)](https://pkg.go.dev/github.com/svyatoslavratov/bugspot)
[![Coverage Status](https://coveralls.io/repos/github/svyatoslavratov/bugspot/badge.svg?branch=main)](https://coveralls.io/github/svyatoslavratov/bugspot?branch=main)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/svyatoslavratov/bugspot/badge)](https://scorecard.dev/viewer/?uri=github.com/svyatoslavratov/bugspot)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Demo](https://img.shields.io/badge/demo-live-2d72d2)](https://svyatoslavratov.github.io/bugspot/)

**Комментарии к элементам страницы для команды и для агентов.** Плавающий жучок в любом
веб-приложении: нажали, выбрали элемент, написали, что не так. Комментарий закрепляется за этим
элементом вместе со скриншотом, браузером, версией приложения, последними ошибками консоли и
неудачными запросами. Разработчики — или ИИ-агент с API-токеном — отвечают в ветке, переводят её
в «в работе» и «исправлен», автор проверяет и закрывает.

Всё хранит один небольшой сервис на Go (SQLite, один файл), он же раздаёт виджет. В приложение
добавляется один тег `<script>`. Кому показывать виджет — решаете вы: от всех подряд до одних
админов, через вход вашего же приложения.

**[Демо →](https://svyatoslavratov.github.io/bugspot/)** (API работает прямо в браузере через WebAssembly)

[English version](README.md)

![Человек оставляет комментарий, агент исправляет через MCP, человек проверяет и закрывает](docs/images/demo.gif)

## Что умеет

- **Метки на элементах.** Комментарий привязан к элементу, а не к координатам: устойчивый
  селектор, текст и точка клика находят его после перерисовок; если элемент пропал, комментарий
  помечается «элемент не найден», а не встаёт не туда. У элемента в модальном окне или всплывающем
  меню метка видна, пока окно открыто, а в комментарии написано, в каком оно окне.
- **Контекст сам собой.** Скриншот видимой части страницы с обведённым элементом (или снимок
  вкладки средствами браузера), браузер и размер окна, версия приложения, последние ошибки консоли
  и неудачные запросы (с `X-Request-ID`; значения параметров запроса отбрасываются).
- **Работа с замечаниями.** Открыт → в работе → исправлен → решён, или отклонён, и отдельная
  отметка «проверено человеком». Ответы, правка по клику на текст, поиск, «эта страница» и «все»,
  метки можно скрыть, «показать на странице» с короткой подсветкой, кнопку можно перетащить.
- **Комментарий за секунды.** Правый клик по жучку или Alt+C (⌥C; можно назначить своё сочетание) —
  и сразу выбор элемента. Shift+клик выбирает несколько элементов с одной проблемой для одного
  комментария (метка на каждом). Писать можно в полной форме в панели или в *компактном* режиме —
  в маленьком поле прямо у элемента, как в Figma (Enter — отправить). После отправки можно сразу
  выбрать следующий элемент, Esc — закончить. Режим и сочетание — под шестерёнкой в шапке панели.
- **Агенты — полноправные участники.** MCP-сервер (`bugspot mcp`), токены с правами, CLI и обычный
  REST API. Агент доводит до «исправлен», проверяет и закрывает только человек.
- **Гибкий доступ.** Пользователь из сессии вашего приложения (`forward`), из JWT, из заголовков
  доверенного прокси, по ссылке с ключом доступа или анонимно — в любом сочетании, с правилами
  «видеть / писать / модерировать» по ролям и пользователям.
- **Лёгкий.** Кому виджет не положен, получает загрузчик на 2,6 КБ и один запрос. Сервис —
  статический бинарник на 12 МБ (образ distroless — 15 МБ), SQLite внутри.
- **Резервные копии.** С `BUGSPOT_BACKUP_DIR` сервис сам хранит датированные снимки базы (при старте,
  затем раз в сутки, 14 дней); `bugspot backup` снимает копию в любой момент.
- **Безопасный по умолчанию.** Защита от CSRF, список разрешённых доменов для CORS, лимиты частоты
  и размера, только проверенные изображения, хеши вместо ключей, контейнер без root и с
  файловой системой только для чтения. Подробнее — [SECURITY.md](SECURITY.md).

Виджет — React и [Blueprint](https://blueprintjs.com) внутри Shadow DOM: стили приложения он не
ломает и не наследует.

## Подключение

### 1. Запустите сервис

Рядом с приложением, например в том же docker-compose:

```yaml
bugspot:
  image: ghcr.io/svyatoslavratov/bugspot:v0.3.2
  restart: unless-stopped
  read_only: true
  volumes: [bugspot-data:/data]
  environment:
    BUGSPOT_PROJECT: crm
    BUGSPOT_AUTH: forward
    BUGSPOT_FORWARD_URL: http://app:8080/api/me
    BUGSPOT_FORWARD_COOKIES: session
    BUGSPOT_FORWARD_MAP: id=user.id,name=user.name,roles=user.role
    BUGSPOT_VIEW: authenticated
    BUGSPOT_COMMENT: authenticated
    BUGSPOT_MODERATE: role:admin
    BUGSPOT_TRUSTED_PROXIES: 172.16.0.0/12
```

Или бинарником из [релизов](https://github.com/svyatoslavratov/bugspot/releases). Данные — в
`/data` (`BUGSPOT_DATA_DIR`), держите его на томе.

### 2. Отдайте его под доменом приложения

Так cookie и Content-Security-Policy работают без настроек:

```nginx
location /bugspot/ {
    proxy_pass http://bugspot:8090/;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 4m;   # скриншоты
}
```

Сервис на другом домене тоже работает: перечислите домены приложения в `BUGSPOT_ALLOWED_ORIGINS`
и используйте провайдер `jwt` или `key` (cookie приложения на чужой домен не уходят).

### 3. Добавьте скрипт

Только там, где виджет нужен (например, на dev и stage):

```html
<script defer src="/bugspot/widget.js" data-version="1.4.2"></script>
```

| Атрибут | Значения | По умолчанию |
| --- | --- | --- |
| `data-api` | адрес сервиса | папка, откуда загружен `widget.js` |
| `data-route` | `auto`, `path`, `hash` (хеш-роутер: `#/page`) | `auto` |
| `data-version` | версия приложения, сохраняется в каждом комментарии | — |
| `data-lang` | `ru`, `en` | язык браузера |
| `data-theme` | `light`, `dark`, `auto` | `light` |
| `data-position` | `bottom-right`, `bottom-left`, `top-right`, `top-left` | `bottom-right` |
| `data-mode` | `full` (форма в панели), `tiny` (маленькое поле у элемента) | `full` |
| `data-hotkey` | сочетание для выбора элемента по коду клавиши: `Alt+KeyC`, `Ctrl+Shift+KeyK`, `F2`; `off` | `Alt+KeyC` |

`data-mode` и `data-hotkey` — значения по умолчанию: каждый может сменить их под шестерёнкой в
панели (они хранятся в его браузере).

`window.bugspotConfig = { token, appVersion, fetch }` до скрипта задаёт то же из кода (`token`
возвращает JWT для провайдера `jwt`).

Сам виджет доступ не решает: загрузчик спрашивает `GET /api/v1/session` и скачивает приложение,
только если сервис ответил `visible: true`.

## Кому показывать виджет

Два слоя: **провайдеры** определяют, кто пользователь, **политика** — что ему можно.

`BUGSPOT_AUTH` — провайдеры по порядку; срабатывает первый, который узнал запрос.

| Провайдер | Когда подходит | Что нужно от приложения |
| --- | --- | --- |
| `forward` | у приложения сессия в cookie на том же домене | ничего: bugspot сам спрашивает ваш эндпоинт «кто я» с cookie пользователя и берёт поля из JSON |
| `jwt` | другой домен или нужно передать точные роли | бэкенд подписывает короткий JWT (HS256, RS256, ES256), страница отдаёт его через `bugspotConfig.token` |
| `header` | перед приложением прокси авторизации (oauth2-proxy, Authelia, Traefik) | ничего: заголовкам верим только с адресов `BUGSPOT_TRUSTED_PROXIES` |
| `key` | нужен комментарий от человека без аккаунта (заказчика) | ссылка `?bugspot_key=bsk_…`; ключ превращается в httpOnly-cookie |
| `anonymous` | открытый сбор отзывов | ничего; гость указывает имя |

У политики три права, каждое — список правил (хватает одного совпадения):

- `BUGSPOT_VIEW` — видеть виджет и читать комментарии;
- `BUGSPOT_COMMENT` — писать комментарии и ответы, править и закрывать свои;
- `BUGSPOT_MODERATE` — менять любой статус, удалять любой комментарий.

Правила: `*` (все), `authenticated` (все, кроме анонимов), `anonymous`, `role:<роль>`,
`user:<id>`, `provider:<провайдер>`.

| Нужно | Настройки |
| --- | --- |
| Только админы | `BUGSPOT_VIEW=role:admin` `BUGSPOT_COMMENT=role:admin` |
| Пишет вся команда, закрывает тимлид | `BUGSPOT_VIEW=authenticated` `BUGSPOT_COMMENT=authenticated` `BUGSPOT_MODERATE=role:lead` |
| Плюс заказчик по ссылке | `BUGSPOT_AUTH=…,key` и `provider:key` в `BUGSPOT_VIEW` и `BUGSPOT_COMMENT` |
| Всем | `BUGSPOT_AUTH=anonymous` `BUGSPOT_VIEW=*` `BUGSPOT_COMMENT=*` |
| Выключить | `BUGSPOT_ENABLED=false` или не добавлять скрипт |

Пример `forward`: приложение отвечает на `GET /api/me` объектом
`{"user": {"id": 7, "name": "Анна", "role": "admin"}}` для вошедшего и `401` для остальных. bugspot
пересылает только перечисленные cookie, только на этот адрес, и помнит ответ 30 секунд. Роли — строка,
строка через запятую или массив.

Другие рецепты (JWT на Go и Node, oauth2-proxy, другой домен, Traefik, Vite): [docs/integration.md](docs/integration.md).

## Агенты

### MCP

`bugspot mcp` — MCP-сервер на stdio с инструментами `list_threads`, `get_thread`, `get_screenshot`
(сама картинка), `reply`, `set_status` и `summary`. Он работает через API с токеном агента, поэтому
у агента ровно те права, что у токена.

```sh
# Claude Code
claude mcp add bugspot --env BUGSPOT_URL=https://app.example.com/bugspot --env BUGSPOT_TOKEN=bsp_… -- bugspot mcp
# без локального бинарника
claude mcp add bugspot -- docker run -i --rm -e BUGSPOT_URL=… -e BUGSPOT_TOKEN=… ghcr.io/svyatoslavratov/bugspot mcp
```

Дальше: *«Почини открытые комментарии bugspot»* — агент получает список, смотрит скриншоты, берёт
комментарий в работу, правит код, отвечает и ставит «исправлен». Человек проверяет, ставит отметку
«проверено» и закрывает.

### CLI

```sh
# рядом с сервисом: создать токен (показывается один раз, хранится только хеш)
docker compose exec bugspot bugspot token create --name claude --scopes read,reply,status

# где угодно: читать и отвечать
export BUGSPOT_URL=https://app.example.com/bugspot BUGSPOT_TOKEN=bsp_…
bugspot threads list                     # открытые и в работе
bugspot threads show 12                  # текст, элемент, контекст, ответы
bugspot threads screenshot 12 --out 12.webp
bugspot threads status 12 in_progress
bugspot threads reply 12 "Исправил в 1.4.3: колонка теперь переносится."
bugspot threads status 12 fixed
```

Стенд за HTTP Basic Auth: логин и пароль — в адрес (`https://user:pass@dev.example.com/bugspot`),
токен идёт в `X-Bugspot-Token`, поэтому они не мешают друг другу. API описан в
[api/openapi.yaml](api/openapi.yaml).

## Настройки

Все настройки — переменные окружения `BUGSPOT_*`, секреты принимают и `*_FILE`. Полный список
с умолчаниями — [docs/configuration.md](docs/configuration.md).

## Разработка

```sh
make widget      # собрать виджет (Node 22) в internal/widgetfs/dist
make build       # bin/bugspot с виджетом внутри
make test        # тесты Go (с -race) и виджета
make demo        # демо для GitHub Pages в _site/
make run         # локальный публичный экземпляр на :8090
```

## Лицензия

[AGPL-3.0](LICENSE). Запуск bugspot и подключение его скрипта к вашему приложению не делают ваше
приложение AGPL: оно общается с bugspot по HTTP. Если вы меняете сам bugspot и даёте им
пользоваться по сети — опубликуйте изменения. Нужны другие условия — напишите в issues.
