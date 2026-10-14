# CH32 AHRS 上位机

纯 HTML/CSS/JavaScript + Web Serial，目标固件 `20261003h`。使用支持 Web Serial 的 Chrome/Edge，通过 WCH-Link 串口桥连接 CH32：UART 2,000,000 baud、8N1、无流控。板端没有 USB 设备接口。

支持状态、输出、校准、诊断、设置五页，包含姿态/IMU 曲线、3D 板卡、响应/均衡/稳定/ZARU 四档、当前/保存配置回读、六面加速度计校准、数据导出和 UART OTA。旧固件的可用档位与参数语义根据设备回读确定。

## 本地运行

需要 Node.js 24 和 npm。在仓库根目录执行：

```powershell
cd upper
npm ci
npm run build
npm run dev
```

打开 `http://127.0.0.1:8765/`，点击连接设备并选择串口。`http://127.0.0.1:8765/?mock=1` 使用模拟设备。服务仅监听 `127.0.0.1`；运行页面所需的渲染器和板卡模型已包含在 `public/`，无需外部 CDN。

`npm run build` 从 `tools/pcb-view.src.js` 重建 `public/pcb-view.js`。修改板卡模型时，可通过 `node tools/convert-step.mjs <board.step>` 重新生成 `public/models/ch32.glb` 和元数据；原始 STEP 文件需自行提供。

## 固件与 OTA

在仓库根目录执行 `python firmware/tools/build_ahrs.py`，工具链要求与参数见[项目说明](../README.md)。编译生成 `firmware/obj/ahrs_real/CH32_AHRS_app.bin`，在设置页选择该应用镜像进行 UART OTA。界面检查能力、CHAP 描述符、CRC32 和大小，并要求用户确认。

OTA 只接受应用镜像，不接受 full/HEX/ELF，也不更新引导程序。预编译固件不随上位机源码提交。

## 测试

在 `upper/` 执行协议、Mock 和 OTA 单元测试：

```powershell
npm test
```

先按项目说明编译固件并启动 `npm run dev`，再开一个终端，在 `upper/` 执行：

```powershell
$env:BASE = 'http://127.0.0.1:8765'
$env:CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:browser
npm run test:layout
npm run test:mobile
```

浏览器测试默认读取 `../firmware/obj/ahrs_real/CH32_AHRS_app.bin`，也可用 `APP_IMAGE` 环境变量指定镜像。测试使用 Mock，不连接真实串口。截图、下载、日志和依赖目录均被忽略。Mock 验证不代表实板运动、振动、CAN 或长期串口可靠性测试。

## 目录

| 目录/文件 | 用途 |
| --- | --- |
| `public/` | 页面、通信协议、Mock、渲染器和板卡模型 |
| `src/index.js`、`wrangler.jsonc` | 现有 Cloudflare Worker 入口和部署配置 |
| `tools/` | 本地服务、渲染器打包和模型转换 |
| `test/` | 协议、OTA、浏览器和布局测试源码 |
| `package.json`、`package-lock.json` | 命令入口和锁定依赖 |

`npm run deploy` 使用现有 Cloudflare 配置，需要相应账户权限。三方许可见 [`public/THIRD-PARTY-NOTICES.txt`](public/THIRD-PARTY-NOTICES.txt)。
