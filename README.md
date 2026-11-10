# 网课题库 · 服务端与查询页面

Go HTTP API、内置 Web 查询页面和超星 MOOC 油猴脚本。脚本可采集课程、单选/多选题和页面可见正确答案，查询私有题库并填写答案；查询页面展示课程、题库、参考答案及贡献来源。

超星脚本安装地址：启动服务后访问 [安装脚本](http://127.0.0.1:8080/userscripts/chaoxing-questionbank.user.js)。私有平台配置、适配方式和验证步骤见 [userscripts/README.md](userscripts/README.md)。

## 本地运行

要求 **Go 1.26+、CGO 和 C 编译器**（SQLite 驱动需要；macOS 可使用 Xcode Command Line Tools）。项目使用标准库 `net/http`、`slog`、GORM 和 YAML 配置。

```sh
go mod download
go run ./cmd/server -config config.yaml
```

默认监听 `http://127.0.0.1:8080`，自动创建 `data/questionbank.db` 和数据表。SQLite 路径相对于配置文件所在目录解析。首次启动不需要手动建表，数据库切换时会在目标数据库创建表，**不会搬运原数据库的数据**。

```sh
curl http://127.0.0.1:8080/healthz
# {"status":"ok"}

go test ./...
go test -race ./...
go vet ./...
go build -o bin/questionbank ./cmd/server
./bin/questionbank -config config.yaml
```

`Ctrl+C` / `SIGTERM` 会等待正在处理的请求结束，再关闭数据库连接。

## Docker 部署

镜像包含 Go 服务、查询页面和油猴脚本，支持 `linux/amd64` / `linux/arm64`，以 UID/GID `10001:10001` 运行。SQLite 通过命名卷持久化，配置文件以只读方式挂载；本地数据库、Token 和配置不会进入构建上下文或镜像。

### 准备配置

```sh
cp deploy/config.docker.example.yaml config.local.yaml
openssl rand -hex 32
# 把生成的随机值填入 config.local.yaml 的 server.api_key
```

容器配置必须监听 `0.0.0.0:8080`，SQLite 路径使用 `/app/data/questionbank.db`。模板的 Token 为空，未设置时服务会拒绝启动。确保容器 UID 10001 可读取挂载的配置文件；修改数据库类型时可参考后文的多数据库配置。

### 使用 Workflow 发布的私有镜像

仓库：<https://github.com/0x00chronos/onlinecourse>。镜像地址：`ghcr.io/0x00chronos/onlinecourse`。

在部署机器上使用具有 `read:packages` 权限、且可访问该私有包的 GitHub Personal Access Token (classic) 登录（交互输入 Token）：

```sh
docker login ghcr.io -u 0x00chronos
export IMAGE=ghcr.io/0x00chronos/onlinecourse:latest
docker compose pull
docker compose up -d --no-build --wait
docker compose ps
curl http://127.0.0.1:8080/healthz
```

打开 `http://127.0.0.1:8080/`，使用配置中的 Token 登录。默认仅在宿主机 `127.0.0.1:8080` 提供服务；可设置 `PORT=18080` 更改宿主端口，设置 `BIND_ADDRESS=0.0.0.0` 允许其他设备连接，公网使用时通过反向代理配置 HTTPS。

更新时重新执行 `docker compose pull` 和 `docker compose up -d --no-build --wait`（同一终端中保留 `IMAGE`，或每次命令前指定）。回滚时将 `IMAGE` 改为指定版本或 `sha-xxxxxxx` 标签，再拉取并启动。镜像回滚不会还原数据库，升级前应备份数据。

```sh
docker compose logs -f --tail=100
docker compose down
```

`down` 保留数据库卷；`down -v` 会删除数据库卷及其中数据。SQLite 备份应在停止服务后复制卷中的数据库文件（包括尚未合并的 WAL），或使用 SQLite 的在线备份工具。

### 本地构建

```sh
docker compose up -d --build --wait
# 或只构建镜像并执行隔离的容器测试，无需本地配置
docker build -t onlinecourse:local .
bash scripts/docker-smoke.sh onlinecourse:local
```

若当前终端已设置 `IMAGE`，本地构建前先执行 `unset IMAGE`。本地测试使用独立的临时容器和数据卷，不改动现有题库。

### GitHub Actions 构建与发布

工作流位于 [`.github/workflows/docker.yml`](.github/workflows/docker.yml)：

应用测试通过后，AMD64 和 ARM64 分别在 GitHub 原生 runner 上构建并执行容器测试；两者全部成功后，才合并并发布带版本标签的双架构镜像。各架构独立缓存构建层，避免 QEMU 模拟编译的开销。

| 触发方式 | 行为 | 镜像标签 |
| --- | --- | --- |
| 推送 `main` | 测试通过后构建双架构镜像并推送 GHCR | `latest`、`main`、`sha-xxxxxxx` |
| 推送 `v1.2.3` 等版本标签 | 测试通过后构建并推送 GHCR | `1.2.3`、`1.2`、`sha-xxxxxxx` |
| 向 `main` 提交 PR | Go race/vet、油猴单测/集成、容器构建与冒烟测试 | 不发布 |
| Actions 页面手动运行 | 执行测试；在 `main` 或 `v*` 标签上运行时发布 | 与对应分支/标签一致 |

```sh
git tag v1.0.0
git push origin v1.0.0
```

`latest` 跟随主分支；版本部署建议指定完整版本或 SHA 标签。发布使用 GitHub 自动提供的 `GITHUB_TOKEN`，仅发布任务授予 `packages: write`，无需额外保存 Docker 密码。首次发布的 GHCR 包默认为私有；不要在包设置中将其改为公开。仓库和镜像的权限行为见 [GitHub Container Registry 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)，双架构构建方式见 [Docker 官方文档](https://docs.docker.com/build/ci/github-actions/multi-platform/)。

## 查询页面与 Token 认证

启动后，浏览器打开 **[http://127.0.0.1:8080/](http://127.0.0.1:8080/)**，输入 `config.yaml` 中 `server.api_key` 的值进入题库。页面由 Go 通过 [embed](https://go.dev/pkg/embed/) 内嵌提供，无需 Node、npm 或额外的前端服务；构建后的二进制已包含 HTML、CSS 和 JavaScript，修改页面源文件后需要重新运行/构建 Go 服务。

默认配置中的 `local-dev-token-change-me` 仅用于本地实验。可以使用 `openssl rand -hex 32` 生成随机 Token，再修改配置并重启服务。**Token 必填**，留空或含空白字符会导致启动失败。所有 `/api/v1/*` 请求都必须携带：

```http
Authorization: Bearer <server.api_key 的值>
```

未携带或错误 Token 返回 401；通过 URL 参数传 Token 不予认证。登录页与静态资源可公开加载，健康检查不要求 Token；课程、题目、答案、上传和检索接口均受保护。

页面功能：

- 按名称搜索课程、课程列表分页，点击课程查看其题库。
- 按题干关键字和单选/多选筛选题目、题目分页。
- 显示全部选项、参考答案、未收录答案和答案冲突状态。
- 显示答案对应的贡献者鸣谢，展开贡献记录并查看来源链接。
- 支持手机窄屏、加载状态、空数据提示、错误提示和手动刷新。

页面使用 [Fetch](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch) 自动发送 Bearer Token。Token 仅保留在当前标签页的 `sessionStorage`；退出或收到 401 时清除 Token 和页面数据。浏览器禁止存储时仍可在内存中使用，刷新后需要重新输入。Token 不会写入静态资源、URL、请求日志或长期 `localStorage`。

这是配置式共享 Token 认证，没有用户帐号、JWT 签发或刷新机制。更换配置中的 Token 并重启服务即可使旧 Token 失效；页面“退出”清除当前标签页凭据，不吊销其他客户端的 Token。贡献者用户名仍由上传脚本提供。

下方 curl 示例使用默认实验 Token。如已修改配置，请同步替换请求头。

## 数据结构

```mermaid
erDiagram
    courses ||--o{ questions : contains
    questions ||--o{ contributions : receives
    courses {
        uint64 id PK
        string identity UK
        string platform
        string external_id
        string name
        datetime created_at
        datetime updated_at
    }
    questions {
        uint64 id PK
        uint64 course_id FK
        string fingerprint
        string type
        text stem
        text normalized_stem
        text options_json
        datetime created_at
        datetime updated_at
    }
    contributions {
        uint64 id PK
        uint64 question_id FK
        string identity UK
        string username
        text source_url
        text answer_json
        datetime created_at
    }
```

- **课程表 `courses`**：平台、平台课程 ID、课程名称。优先按“平台 + external_id”去重；未提供平台课程 ID 时按“平台 + 名称”去重。建议脚本始终传稳定的 `external_id`。重复登记返回已有课程，不覆盖名称；首次按名称创建、以后改用 ID 创建会视为不同课程。
- **题库表 `questions`**：课程、题型、题干、选项。唯一键为 `(course_id, fingerprint)`。指纹包含题型、规范化题干、排序后的选项文本，因此选项换序或字母改变仍能匹配；不同课程不会混用答案。
- **贡献表 `contributions`**：上传用户名、来源页面 URL、答案集合、上传时间。答案保存为选项文本，查询时映射为当前页面的选项 key。无答案时也保存上传来源，后续可补充答案。

数据库中的 JSON 使用通用 TEXT 字段，避免业务逻辑依赖某个数据库的 JSON 查询语法。外键约束防止孤立题目和贡献记录。SQLite 启用 WAL、外键、5 秒 busy timeout，连接池限制为单连接以串行化当前进程的数据库操作。

## 接口

所有业务请求携带 `Authorization: Bearer <token>`；POST 另需 `Content-Type: application/json`，请求字段严格校验。成功返回 `data`；错误返回 `error.code`、`error.message` 和 `error.request_id`，响应头也有 `X-Request-ID`。业务接口响应设置 `Cache-Control: no-store`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/healthz` | 服务及数据库健康检查 |
| POST | `/api/v1/courses` | 幂等登记课程；新建 201，已存在 200 |
| GET | `/api/v1/courses` | 课程列表，支持 `platform`、名称关键字 `q`、分页 |
| POST | `/api/v1/questions/batch` | 原子批量上传题目、可选答案及贡献者 |
| GET | `/api/v1/questions` | 题库列表，支持 `course_id`、`type`、题干关键字 `q`、分页 |
| GET | `/api/v1/questions/{id}` | 题目详情、全部候选答案和来源 |
| POST | `/api/v1/questions/search` | 按课程、题型、题干和选项精确匹配，返回当前页面选项 key |

分页：`page=1&page_size=20`，页码最多 10000，每页最多 100。列表返回 `data`、`total`、`page`、`page_size`；关键字 `q` 最多 500 字，执行文字包含查询，`%` 和 `_` 按普通字符处理。

### 1. 登记课程

```sh
curl -X POST http://127.0.0.1:8080/api/v1/courses \
  -H 'Authorization: Bearer local-dev-token-change-me' \
  -H 'Content-Type: application/json' \
  --data-binary @examples/course.json
```

```json
{
  "platform": "示例网课平台",
  "external_id": "go-101",
  "name": "Go 语言基础"
}
```

记下响应的 `data.id`，用于后续请求的 `course_id`。下面示例假设为 `1`。

### 2. 上传单选、多选和暂时无答案的题

```sh
curl -X POST http://127.0.0.1:8080/api/v1/questions/batch \
  -H 'Authorization: Bearer local-dev-token-change-me' \
  -H 'Content-Type: application/json' \
  --data-binary @examples/upload.json
```

```json
{
  "course_id": 1,
  "contributor": {
    "username": "小明",
    "source_url": "https://course.example/quiz/1"
  },
  "questions": [
    {
      "type": "single",
      "stem": "Go 声明函数的关键字是？",
      "options": [{"key": "A", "text": "func"}, {"key": "B", "text": "function"}],
      "correct_answers": ["A"]
    },
    {
      "type": "multiple",
      "stem": "以下哪些是 Go 的内置类型？",
      "options": [{"key": "A", "text": "int"}, {"key": "B", "text": "string"}, {"key": "C", "text": "varchar"}],
      "correct_answers": ["A", "B"]
    },
    {
      "type": "single",
      "stem": "Go 是否支持垃圾回收？",
      "options": [{"key": "A", "text": "支持"}, {"key": "B", "text": "不支持"}]
    }
  ]
}
```

`correct_answers` 是选项 key 数组，缺省或 `[]` 表示未知答案。单选最多一个，多选至少一个才构成已知答案。题目至少 2 个选项、最多 26 个；选项 key 和规范化后的文本均不能重复。题干最多 10000 字，选项文本最多 5000 字。前端需先提取纯文本；后端不解析页面 HTML，也不删除题号、选项字母或标点。

每批 1–100 题，共用贡献者和来源 URL。不同来源页请分批上传。任意题目不合法，整批不写入；不存在的课程返回 404。响应按上传顺序返回：

```json
{
  "data": [{"question_id": 1, "question_created": true, "contribution_created": true}],
  "received": 1,
  "new_questions": 1,
  "new_contributions": 1
}
```

上面响应只演示上传一题的情况。同题、同用户名、同来源 URL、同答案集合重复上传不会重复写入；同题的新来源或新答案保留为新的贡献记录。原来无答案的题目再上传答案，会复用题目并追加贡献。

### 3. 搜索并获取当前页面的答案编号

```sh
curl -X POST http://127.0.0.1:8080/api/v1/questions/search \
  -H 'Authorization: Bearer local-dev-token-change-me' \
  -H 'Content-Type: application/json' \
  --data-binary @examples/search.json
```

```json
{
  "course_id": 1,
  "type": "single",
  "stem": "Go 声明函数的关键字是？",
  "options": [{"key": "A", "text": "function"}, {"key": "B", "text": "func"}]
}
```

虽然原始正确答案是 A，但页面顺序改变后会返回 B。响应主要字段如下（实际还包含完整题目及贡献时间）：

```json
{
  "match": "exact",
  "data": {
    "id": 1,
    "course_id": 1,
    "type": "single",
    "stem": "Go 声明函数的关键字是？",
    "options": [{"key": "A", "text": "function"}, {"key": "B", "text": "func"}],
    "has_answer": true,
    "conflict": false,
    "answer_candidates": [
      {
        "answer_keys": ["B"],
        "answer_texts": ["func"],
        "support_count": 1,
        "contributors": [{"username": "小明", "source_url": "https://course.example/quiz/1"}]
      }
    ]
  }
}
```

- 未匹配：`{"match":"none","data":null}`，HTTP 200。
- 题目有记录但没有答案：`match="exact"`，`has_answer=false`，`answer_candidates=[]`，题目级 `contributors` 仍记录来源。
- 不同答案均保留，`conflict=true`。每个候选包含自己的 `contributors`，脚本可显示“感谢 小明 提供答案”。
- `support_count` 是该候选的不同用户名数；同用户不同来源页不重复计数。按支持数降序返回，**不代表已验证正确**。建议未来脚本仅在 `match=exact && has_answer && !conflict` 时使用答案，其余情况由用户判断。
- 用户名由脚本自报，当前没有用户注册、身份认证或人工审核。API Key 仅限制接口访问，不能证明贡献者身份。页面展示用户名、题干和选项时使用 `textContent`，不要将接口文本直接拼接到 `innerHTML`。

精确匹配仅做 Unicode NFC 和空白折叠，保留大小写、标点。题干、题型或选项集合变化时不会命中；关键字列表查询可用于人工检索，不用于自动填答。

### 4. 列表与错误

```sh
curl -H 'Authorization: Bearer local-dev-token-change-me' 'http://127.0.0.1:8080/api/v1/courses?page=1&page_size=20'
curl -H 'Authorization: Bearer local-dev-token-change-me' 'http://127.0.0.1:8080/api/v1/questions?course_id=1&type=multiple&page=1&page_size=20'
curl -H 'Authorization: Bearer local-dev-token-change-me' 'http://127.0.0.1:8080/api/v1/questions/1'
```

```json
{"error":{"code":"validation_error","message":"单选题最多一个正确答案","request_id":"..."}}
```

常见状态：400 参数/JSON 错误，401 Token 错误，403 Origin 不允许，404 课程/题目/接口不存在，413 请求体过大（默认 2 MiB），415 Content-Type 错误，500 服务端错误，503 健康检查数据库不可用，504 数据库处理超时。

## 配置多数据库

复制 `config.yaml` 为 `config.local.yaml`，修改所需部分，再通过 `-config config.local.yaml` 启动。使用 [GORM 官方驱动](https://gorm.io/docs/connecting_to_the_database.html)，三个数据库共用业务逻辑；SQLite 已做本地集成测试，MySQL/PostgreSQL 需要可用实例进行联调。

SQLite（默认）：

```yaml
database:
  driver: sqlite
  sqlite:
    path: data/questionbank.db
```

MySQL（建议 MySQL 8+，提前创建数据库并使用 utf8mb4 字符集）：

```yaml
database:
  driver: mysql
  mysql:
    dsn: "questionbank:password@tcp(127.0.0.1:3306)/questionbank?charset=utf8mb4&parseTime=True&loc=UTC"
```

PostgreSQL（`driver: pgsql` 同样支持，配置节点仍叫 `postgres`）：

```yaml
database:
  driver: postgres
  postgres:
    dsn: "host=127.0.0.1 port=5432 user=questionbank password=password dbname=questionbank sslmode=disable TimeZone=UTC"
```

以上密码均为示例。MySQL 的 `parseTime=True` 用于时间解析；PostgreSQL 的 `sslmode=disable` 适合本地实验，远程连接按数据库要求配置 TLS。数据库帐号需要建表、索引和外键权限。配置读取使用严格 YAML 校验，拼错字段会在启动时提示。

## 日志和油猴对接

日志输出到 stdout，带时间、级别、中文事件说明及 `component` 标签。日志使用 [Go slog](https://pkg.go.dev/log/slog)，`log.format` 可选 `text` / `json`，`log.level` 可选 `debug` / `info` / `warn` / `error`。

```text
time=... level=INFO msg=数据库连接与表迁移完成 component=database driver=sqlite
time=... level=INFO msg=题库服务启动 component=server address=127.0.0.1:8080 driver=sqlite auth_enabled=true
time=... level=INFO msg=题库批量上传完成 component=question request_id=... course_id=1 received=3 new_questions=3 new_contributions=3
time=... level=INFO msg=HTTP请求 component=http request_id=... method=POST path=/api/v1/questions/batch status=200 duration_ms=2
```

记录启动、迁移、批量操作、HTTP 状态及耗时；SQL 失败和慢查询会标注 `component=database`，普通 SQL 耗时只在 debug 级别输出。不记录请求体、Authorization、DSN、SQL 参数或用户名。HTTP [请求体大小和超时](https://pkg.go.dev/net/http) 均有限制。

油猴使用 `GM_xmlhttpRequest` 调用以上接口，设置 `headers: { Authorization: "Bearer " + token }`，并配置 `@connect 127.0.0.1`（如果后端使用其他主机名，改为对应主机）。Go 内置页面同源访问自动允许；若油猴使用普通 `fetch`，将外部课程页面的 Origin 加入：

```yaml
server:
  allowed_origins:
    - "https://course.example"
```

携带未获允许的跨域 Origin 会返回 403；同源请求或不带 Origin 的请求仍须通过 Token 认证。通配 `"*"` 支持放行所有 Origin，默认列表为空。CORS 预检不要求 Token，实际业务请求必须携带 Token。若通过反向代理提供 HTTPS，请把外部页面 Origin 加入列表；CORS 不替代访问鉴权。

如需开放给其他设备，设置 `server.address: "0.0.0.0:8080"` 并将默认实验 Token 替换为随机 Token；公网部署再通过反向代理提供 HTTPS。当前默认配置仅绑定本地环回地址。

## 项目结构

```text
cmd/server/          启动、日志初始化、优雅退出
internal/config/     YAML 配置和校验
internal/database/   多数据库连接、迁移、SQL 日志
internal/model/      三张数据表
internal/bank/       去重、上传、匹配、候选答案与鸣谢
internal/httpapi/    HTTP 路由、鉴权、CORS、请求日志、集成测试
internal/web/        内嵌查询页面（HTML/CSS/JS）
userscripts/         超星油猴脚本、DOM 样例及采集/填写测试
examples/            可直接用于 curl 的 JSON
config.yaml          SQLite 本地默认配置
```
