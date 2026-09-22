# CH32V203G6U Fixed-VQF IMU

基于 **WCH CH32V203G6U6** 的六轴 IMU 姿态解算工程。项目使用 LSM6DSV 作为陀螺仪和加速度计，运行定点 Full-VQF（6D，无磁力计）融合，并通过 CAN 和 UART 输出角速度、加速度及欧拉角数据。

> 当前仓库于 2026-09-22 创建并推送。工程面向 MounRiver Studio，目标芯片为 CH32V203G6U6。

## 主要特性

- CH32V203G6U6，系统时钟 144 MHz
- RISC-V RV32IMACXW，使用硬件整数乘法/乘积指令
- LSM6DSV SPI 读取
- HAODR 高性能模式
- 默认 2 kHz 传感器采样与 VQF 融合
- 1 kHz CAN 与 UART 姿态输出
- 定点 Full-VQF 6D 融合
  - 陀螺仪积分
  - 加速度计重力方向校正
  - 静止检测
  - 静止 bias estimator
  - motion bias estimator
  - 高精度定点滤波器和 Kalman 状态
- 无磁力计，因此 yaw 没有绝对航向参考
- PA9 呼吸灯
- CAN 1 Mbps
- UART2 921600 baud，VOFA JustFloat 输出
- WCH-Link 烧录和 GDB 运行诊断变量
- CPU 负载、采样丢失、CAN/UART 发送计数等运行时诊断

## 硬件连接

以下为当前固件使用的主要接口，实际原理图连接应以硬件设计为准。

| 功能 | 芯片引脚/外设 |
|---|---|
| LSM6DSV SPI | SPI 外设，片选 PA4 |
| LSM6DSV CS | PA4 |
| UART TX | USART2_TX，PA2 |
| UART RX | USART2_RX，PA3 |
| CAN | CAN1_TX/CAN1_RX |
| 状态灯/呼吸灯 | PA9 |
| 调试/烧录 | WCH-Link |

UART 转换器必须连接到 **PA2**，不能将 WCH-Link 调试串口或其他串口误认为 USART2 输出。

## 关键配置

### 采样与融合

配置位于 `User/fixed_vqf.h`：

可通过以下宏独立选择量程，默认均为 `0U`，保持原来的参数：

```c
#define LSM6DSV_GYRO_FS_2000DPS 0U
#define LSM6DSV_ACCEL_FS_4G     0U
```

将对应宏改为 `1U` 后重新编译即可启用 ±2000 dps 或 ±4 g。

```c
#define FIXED_VQF_SAMPLE_HZ     2000U
#define FIXED_VQF_MOTION_BIAS_ENABLED 1U
#define FIXED_VQF_REST_BIAS_ENABLED   1U
#define FIXED_VQF_BIAS_SIGMA_REST_DPS 0.03f
```

配置位于 `User/main.c`：

```c
#define UART_BAUD_RATE          921600U
#define OUTPUT_RATE_HZ          1000U
#define CAN_GYRO_PERIOD_MS      1U
#define CAN_ACCEL_PERIOD_MS     1U
#define CAN_EULER_PERIOD_MS     1U
#define YAW_REST_HOLD_ENABLE    0U
```

LSM6DSV 默认配置为：

- 加速度计：HAODR 2 kHz，默认量程 ±2 g（可选 ±4 g）
- 陀螺仪：HAODR 2 kHz，默认量程 ±125 dps（可选 ±2000 dps）
- BDU 和地址自动递增开启
- 陀螺仪 LPF1 约 101 Hz
- 软件端另有定点二阶低通滤波

如需改为约 1 kHz 采样，将 `FIXED_VQF_SAMPLE_HZ` 改为 `1000U`，并重新编译、烧录和验证。

## 定点数据格式

`User/fixed_vqf.h` 中定义了主要定点格式：

| 类型 | 含义 |
|---|---|
| `q30_t` | Q1.30，四元数、单位向量、旋转矩阵等 |
| `q24_t` | Q7.24，陀螺仪角速度，单位 rad/s |
| `gyro_bias_q32` | Q31.32，内部陀螺仪 bias |
| `bias_P_q20` | Q20，bias 协方差 |
| 欧拉角 | Q16.16 度，1 LSB = 1/65536 度 |

欧拉角运行时变量：

```c
volatile int32_t vqf_euler_q16[3];
```

数组顺序为：

```text
[0] roll
[1] pitch
[2] yaw
```

## CAN 输出

CAN 总线速率为 **1 Mbps**，默认使用以下 ID：

| CAN ID | 内容 | 周期 |
|---:|---|---:|
| `0x301` | 三轴角速度 | 1 ms |
| `0x302` | 三轴加速度 | 1 ms |
| `0x303` | 欧拉角 | 1 ms |

CAN 欧拉角输出采用达妙 IMU 主动输出风格的兼容布局，当前代码保留 CAN 端的 0.01° 分辨率；内部计算仍使用 Q16.16 度。

具体缩放和字节布局请以 `User/main.c` 中的 `CAN1_Service()` 为准。

## UART / VOFA JustFloat

UART 使用 USART2：

```text
波特率：921600
数据位：8
停止位：1
校验：无
```

每帧 16 字节：

| 偏移 | 内容 |
|---:|---|
| 0 | roll，float32，小端 |
| 4 | pitch，float32，小端 |
| 8 | yaw，float32，小端 |
| 12 | VOFA JustFloat 帧尾 `00 00 80 7F` |

有效输出频率为 1 kHz。VOFA 配置为 JustFloat，并选择正确的 COM 口。

如果 UART 计数持续增加但 VOFA 没有数据，应优先检查：

1. USB-UART 是否接到 PA2；
2. COM 口是否选择正确；
3. 波特率是否为 921600；
4. 电平是否为 3.3 V TTL；
5. PA2 是否存在 921600 波形；
6. VOFA 帧尾是否配置为 `00 00 80 7F`。

## 编译

### MounRiver Studio

1. 用 MounRiver Studio 打开项目目录。
2. 选择 `CH32V203G6U` 工程。
3. 选择对应的 Debug/Release 配置。
4. 执行 Build Project。
5. 使用 WCH-Link 下载到 CH32V203G6U6。

### 命令行

在 Windows PowerShell 中，将 MounRiver RISC-V GCC 加入 PATH 后执行：

```powershell
$tool='D:\MounRiverStudio\MounRiver_Studio2\resources\app\resources\win32\components\WCH\Toolchain\RISC-V Embedded GCC\bin'
$env:Path="$tool;$env:Path"
mingw32-make.exe -j8 all
```

构建生成文件位于 `obj/`。`obj/` 和常见编译产物已加入 `.gitignore`，不会提交到仓库。

## WCH-Link 烧录

可以使用 MounRiver Studio 的下载功能，或使用工程中提供的 WCH/OpenOCD 配置文件进行调试和烧录。

烧录完成后应确认：

```text
Programming Finished
Verified OK
Resetting Target
```

烧录后建议检查：

- `lsm_test_result == 3`
- `lsm_who_am_i == 0x70`
- `SystemCoreClock == 144000000`
- `vqf_update_count` 持续增加
- `can_tx_error_count == 0`
- `uart_tx_frame_count` 持续增加
- `vqf_missed_count` 不应持续快速增长

## 运行时诊断变量

这些变量可以通过 WCH-Link/GDB 观察：

| 变量 | 说明 |
|---|---|
| `lsm_test_result` | LSM6DSV 自检结果，`3` 表示通过 |
| `lsm_who_am_i` | LSM6DSV WHO_AM_I，预期 `0x70` |
| `lsm_data_ready_count` | 有效传感器采样次数 |
| `lsm_data_not_ready_count` | 未准备好次数 |
| `vqf_update_count` | VQF 更新次数 |
| `vqf_missed_count` | 未读取到新数据的次数 |
| `vqf_euler_q16[3]` | 内部 Q16.16 欧拉角 |
| `gyro_cal_bias_q16[3]` | 当前估计的 gyro bias |
| `cpu_load_permille` | CPU 占用率，千分比 |
| `can_tx_error_count` | CAN 发送错误次数 |
| `uart_tx_frame_count` | UART DMA 提交帧数 |
| `uart_tx_dma_busy_count` | UART DMA 忙时丢弃次数 |
| `fixed_vqf_kalman_update` | bias Kalman 更新次数 |
| `fixed_vqf_kalman_reject` | bias Kalman 拒绝次数 |

CPU 占用率的换算：

```text
CPU 占用率（%） = cpu_load_permille / 10
```

## Yaw 说明

本工程使用 6D VQF，没有磁力计，因此 yaw 只能表示相对于启动方向的角度，不能提供绝对航向。

当前：

```c
#define YAW_REST_HOLD_ENABLE 0U
```

表示关闭静止 yaw 保持。上电瞬间 yaw 可能不是严格 0°，原因包括：

- 启动时四元数和传感器滤波器需要建立；
- 启动前几次采样中的陀螺仪零偏会被积分；
- yaw 没有加速度计可观测的绝对参考；
- UART/CAN 输出存在量化和调度时序。

如果需要“上电后第一帧 yaw 为 0°”，应在确认设备静止后建立启动 yaw offset；这只会重新定义输出零点，不能从根本上消除无磁力计情况下的 yaw 漂移。

## 常见问题排查

### UART 输出不更新

先通过 GDB 检查 `uart_tx_frame_count` 是否增加：

- 增加：固件正在提交发送，检查 PA2、电平、COM 口和 USB-UART；
- 不增加：检查主循环、定时器、LSM6DSV 数据就绪和 DMA 配置。

### 三轴姿态异常漂移

建议依次检查：

1. `lsm_who_am_i` 是否为 `0x70`；
2. 加速度计静置时模长是否接近 1 g；
3. 陀螺仪零偏是否稳定；
4. 传感器坐标轴映射和符号是否正确；
5. `fixed_vqf_kalman_reject` 是否异常增加；
6. CPU 是否超载导致采样丢失；
7. 是否把旧传感器数据重复送入 VQF；
8. 是否误启用了与采样频率不匹配的滤波器参数。

### 上电后 yaw 不是 0°

这是无磁力计 6D 融合的正常现象。需要软件启动 offset 或外部航向参考，不能仅依靠加速度计将 yaw 校正为绝对 0°。

## 目录结构

```text
CH32V203G6U/
├── Core/                 RISC-V 核心支持文件
├── Debug/                调试支持文件
├── Ld/                   链接脚本
├── Peripheral/           CH32V20x 外设库
├── Startup/              启动文件
├── User/
│   ├── main.c            应用主程序、传感器、CAN、UART、诊断
│   ├── fixed_vqf.c       定点 Full-VQF 实现
│   ├── fixed_vqf.h       定点格式与算法配置
│   ├── vqf.c             浮点 VQF 参考实现
│   └── vqf_types.h       VQF 类型定义
├── Ld/Link.ld            链接脚本
├── CH32V203G6U.wvproj    MounRiver 工程文件
└── README.md             本说明
```

## 许可

`User/VQF-C-LICENSE.txt` 包含 VQF-C 相关许可信息。CH32 外设库和启动文件的许可/版权信息以对应源文件头部声明为准。

## 当前限制

- 无磁力计，无法提供绝对 yaw；
- CAN 端欧拉角仍为 0.01° 兼容分辨率；
- 921600 baud 下的 UART 输出依赖正确的 TTL 电气连接；
- 2 kHz 采样和定点 VQF 的 CPU 占用会随 bias estimator、滤波和输出配置变化；
- 任何硬件改动后都应重新执行 LSM6DSV、CAN、UART 和静置漂移测试。
