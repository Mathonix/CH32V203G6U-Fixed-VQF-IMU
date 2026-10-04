# CH32V203G6U AHRS

`20261003h`最小可编译固件工程：CH32V203G6U6 + LSM6DSV SPI，定点VQF、六面加速度计校准、固定阈值ZARU、CAN和UART OTA。

## 编译

需要Python 3及WCH RISC-V Embedded GCC 12工具链。脚本构建APP和独立BL，不依赖IDE生成的makefile。

```powershell
python tools/build_ahrs.py --toolchain 'D:\MounRiverStudio\MounRiver_Studio2\resources\app\resources\win32\components\WCH\Toolchain\RISC-V Embedded GCC12\bin'
```

也可通过`RISCV_GCC_BIN`环境变量指定工具链bin目录。输出位于`obj/ahrs_real/`：

- `CH32_AHRS_app.bin`：应用，烧录地址`0x08000400`，UART OTA使用此文件。
- `boot_stub.bin`：BL，烧录地址`0x08000000`。

最小工程已独立编译验证：APP 31,088B、BL 996B，与`v20261003h`的两个Release附件逐字节一致。

## 接口与许可

USART2：PA2=TX、PA3=RX，2,000,000 baud、8N1；WCH-Link UART交叉连接并共地。系统时钟144MHz，IMU/VQF采样2kHz。

VQF许可见`User/VQF-C-LICENSE.txt`；WCH库的版权和使用条件见对应源文件头。
