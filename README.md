# CH32V203G6U AHRS

基于 CH32V203G6U6 和 LSM6DSV 的六轴 AHRS 固件。通过 SPI 读取惯性数据，使用定点 VQF 解算姿态，并通过 UART 和 CAN 输出数据。当前固件版本为 `20261003h`。

## 功能

- 定点 VQF 姿态解算，提供响应、均衡、稳定三档参数，以及固定阈值 ZARU 航向保持模式。
- 六面加速度计校准，校准结果与配置支持 Flash 持久化。
- 2 Mbps UART 通信，支持 AA55 协议、参数配置和数据输出。
- CAN 数据输出，以及独立引导程序支持的 UART OTA 升级。

## 目录

项目代码位于 [`firmware/`](firmware/)：

| 目录 | 内容 |
| --- | --- |
| `User/`、`App/` | 主程序、定点 VQF 与应用逻辑 |
| `BSP/`、`Drivers/` | 板级配置与 IMU 驱动 |
| `Services/` | 姿态解算、校准与 ZARU 服务 |
| `Protocol/`、`Transport/` | 通信协议与 UART 传输 |
| `Storage/`、`Boot/` | 配置存储、OTA 与引导程序 |
| `Core/`、`Peripheral/`、`Startup/`、`Ld/`、`Debug/` | 芯片库、启动代码与链接配置 |
| `Utils/`、`tools/` | 公共工具与构建脚本 |

上位机位于 [`upper/`](upper/)，包含 Web Serial 页面、3D 板卡模型、本地服务和构建/测试脚本。仓库只保留固件最小编译所需文件及上位机源码与必要资源；工具链、`node_modules`、编译产物、ZIP、截图和运行日志不进入 Git。

## 编译

需要Python 3及WCH RISC-V Embedded GCC 12工具链。脚本构建APP和独立BL，不依赖IDE生成的makefile。

```powershell
python firmware/tools/build_ahrs.py --toolchain 'D:\MounRiverStudio\MounRiver_Studio2\resources\app\resources\win32\components\WCH\Toolchain\RISC-V Embedded GCC12\bin'
```

在仓库根目录执行上述命令，也可通过`RISCV_GCC_BIN`环境变量指定工具链bin目录。输出位于`firmware/obj/ahrs_real/`：

- `CH32_AHRS_app.bin`：应用，烧录地址`0x08000400`，UART OTA使用此文件。
- `boot_stub.bin`：BL，烧录地址`0x08000000`。

`20261003h` 应用镜像大小为 31,088B，引导程序为 996B。预编译固件可从 [Release](https://github.com/Mathonix/CH32V203G6U-Fixed-VQF-IMU/releases/tag/v20261003h) 下载。

## 上位机

需要 Node.js 24 和支持 Web Serial 的 Chrome/Edge。在仓库根目录执行：

```powershell
cd upper
npm ci
npm run build
npm run dev
```

打开 `http://127.0.0.1:8765/` 连接串口；`http://127.0.0.1:8765/?mock=1` 为模拟设备演示。上位机支持姿态/IMU 曲线、四档滤波、六面校准、输出配置和 UART OTA。OTA 使用上述编译生成的 `firmware/obj/ahrs_real/CH32_AHRS_app.bin`。完整运行和测试步骤见 [`upper/README.md`](upper/README.md)。

## 接口与许可

USART2：PA2=TX、PA3=RX，2,000,000 baud、8N1；WCH-Link UART交叉连接并共地。系统时钟144MHz，IMU/VQF采样2kHz。

VQF许可见 [`firmware/User/VQF-C-LICENSE.txt`](firmware/User/VQF-C-LICENSE.txt)；WCH库的版权和使用条件见对应源文件头。
