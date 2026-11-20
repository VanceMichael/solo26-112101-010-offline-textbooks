# 校园离线教材的按课领取与平板激活

出版社在 `/publisher/releases` 提供版本、适用用户和练习入口至资源的引用，`complete` 为这一版的封卷标志。许可转移必须有该教材的引用授权编号。资源目录 `/publisher/media` 给定 SHA-256、字节数及可读路径。媒体有时给出整件，也可能只给使用指定基件的单次字节替换描述。更新块的 `offset` 指该基件从零开始的字节偏移，删去 `remove` 个字节后写入 Base64 解码所得的 `bytes`，结果按目标指纹核对。镜像 A 和 B 可分别提供同一更新块的不同半开字节区间，区间、公示更新块指纹、成本及截止时间都在资源目录公布。课堂批准期间以演练整数时标为准。
 
学校订单在 `/school/reservations`。空间和本次领取限额在 `/school/window`，调配以课堂优先顺序和可用时点为准。 `data/cache-inventory.json` 提供窗口开始前校端已有原件和设备各自确认的本地安装，二者是独立库存。平板在 `/devices/平板/ack` 查询实际激活凭据。 `POST /devices/平板/install` 提交的描述记录教材、版本、对应入口和内容指纹；提交受理不能代替完整激活。撤回列表 `/publisher/withdrawals` 提供受影响的授权和练习入口。

## 本地来源

资料均为合成记录。Node.js 22 环境下执行 `npm ci`，再用 `npm run sources` 启动，默认监听 `127.0.0.1:4180`。可用环境变量 `PORT` 修改端口。在容器中运行时，服务和访问端处于同一网络命名空间。

`data/sources.json` 保存原始报文及站点页面。连续响应由来源按同一进程内的观察次数提供。阶段从 `initial` 启动，本地演练人员可用 `POST /scenario/阶段名` 切换，未覆盖的路由延用初始响应。切换不清空来源的请求记录。重开服务会复位。

执行 `npm test` 核对来源契约。依赖锁仅包含 Node.js 标准库运行所需的项目清单。容器方式可先执行 `docker build -t offline-textbooks-sources .`，再执行 `docker run --rm offline-textbooks-sources`。镜像准备完成后的验证不需要外网。
