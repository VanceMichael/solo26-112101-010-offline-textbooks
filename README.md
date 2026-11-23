# 校园离线教材的按课领取与平板激活

出版社在 `/publisher/releases` 提供版本、适用用户和练习入口至资源的引用，`complete` 为这一版的封卷标志。许可转移必须有该教材的引用授权编号。资源目录 `/publisher/media` 给定 SHA-256、字节数及可读路径。媒体有时给出整件，也可能只给使用指定基件的单次字节替换描述。更新块的 `offset` 指该基件从零开始的字节偏移，删去 `remove` 个字节后写入 Base64 解码所得的 `bytes`，结果按目标指纹核对。镜像 A 和 B 可分别提供同一更新块的不同半开字节区间，区间、公示更新块指纹、成本及截止时间都在资源目录公布。课堂批准期间以演练整数时标为准。
 
学校订单在 `/school/reservations`。空间和本次领取限额在 `/school/window`，调配以课堂优先顺序和可用时点为准。 `data/cache-inventory.json` 提供窗口开始前校端已有原件和设备各自确认的本地安装，二者是独立库存。平板在 `/devices/平板/ack` 查询实际激活凭据。 `POST /devices/平板/install` 提交的描述记录教材、版本、对应入口和内容指纹；提交受理不能代替完整激活。撤回列表 `/publisher/withdrawals` 提供受影响的授权和练习入口。

## 本地来源

资料均为合成记录。Node.js 22 环境下执行 `npm ci`，再用 `npm run sources` 启动，默认监听 `127.0.0.1:4180`。可用环境变量 `PORT` 修改端口。在容器中运行时，服务和访问端处于同一网络命名空间。

`data/sources.json` 保存原始报文及站点页面。连续响应由来源按同一进程内的观察次数提供。阶段从 `initial` 启动，本地演练人员可用 `POST /scenario/阶段名` 切换，未覆盖的路由延用初始响应。切换不清空来源的请求记录。重开服务会复位。

执行 `npm test` 核对来源契约。依赖锁仅包含 Node.js 标准库运行所需的项目清单。容器方式可先执行 `docker build -t offline-textbooks-sources .`，再执行 `docker run --rm offline-textbooks-sources`。镜像准备完成后的验证不需要外网。

## 校端接收服务

`npm run service` 启动校端接收服务（默认 `127.0.0.1:4181`）。可用环境变量：`PORT`（服务端口）、`SOURCE_URL`（演练来源，默认 `http://127.0.0.1:4180`）、`STATE_PATH`（状态文件，默认 `data/service-state.json`）、`CACHE_DIR`（字节缓存目录，默认 `data/service-cache`）、`CACHE_INVENTORY`（窗口开始前校端已有原件清单，默认 `data/cache-inventory.json`）。

### 接口

- `POST /sync`：拉取发布声明、资源目录、撤回列表、接收窗口、班级预约与各设备凭据，给出本窗口领取规划；`POST /receive` 按规划领取并向设备提交安装描述；`POST /run` 相当于两者连做。
- `GET /plan`、`GET /reservations`、`GET /reservations/:id`：教研员视角——目标版、实际可用版、阻塞原因与受影响的课堂入口。
- `POST /reservations/:id/reselect`：登记教师重新选版（如 `{"release": 2}`），清除该预约的缺口标记后按新目标重排。
- `GET /classroom-records`：激活回执落成的课堂记录，逐入口对照当时引用与今天是否还可再次装载。
- `GET /cache`、`GET /devices/:device`、`GET /status`：字节缓存及各教材授权有效性、设备凭据、窗口用量。

### 领取与判定规则

- 字节缓存按内容指纹寻址，同名文件不会覆盖在用课堂版；相同字节在各教材授权各自有效时可共享，有效期与逻辑键跳转关系不跨教材沿用。
- 规划按课堂优先顺序分配一次接收额度与磁盘：同一预约的下载整套分配，额度或磁盘不足时保持原状并说明缺口，证明哪些版本可完备领取、哪些只能部分准备。
- 更新块按资源目录公示的半开区间向各镜像领取，装配后核对更新块指纹，应用到指定基件再核对目标指纹。
- 只有设备回执完整激活（`state=active` 且预约入口指纹齐全）才判定可离线使用；提交受理不代表激活。服务重启后凭状态文件与缓存继续，不重复提交安装。
- 出版社撤回的授权在排课上标出缺口并等待教师重新选版，不静默换题、不静默恢复；其他教材对同一字节的独立有效引用继续可用。

### 演练流程

```sh
npm run sources &          # 演练来源，默认 4180
npm run service &          # 校端服务，默认 4181
curl -X POST localhost:4181/run                      # 初始窗口：同步并领取
curl -X POST localhost:4180/scenario/sync            # 出版社封版
curl -X POST localhost:4181/sync
curl -X POST localhost:4180/scenario/revoked         # 授权撤回
curl -X POST localhost:4181/sync
curl localhost:4181/reservations/R1                  # 教研员核查
```
