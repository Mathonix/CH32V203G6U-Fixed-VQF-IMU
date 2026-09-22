/********************************** (C) COPYRIGHT *******************************
 * File Name          : main.c
 * Description        : LSM6DSV SPI diagnostic + PA9 status LED.
 *******************************************************************************/

#include "debug.h"
#include "ch32v20x_can.h"
#include "fixed_vqf.h"
#include "sections.h"

#define BREATH_PWM_PERIOD       999U
#define BREATH_STEP_DELAY_MS    1U

#define LSM_CS_PORT             GPIOA
#define LSM_CS_PIN              GPIO_Pin_4
#define LSM_WHO_AM_I_REG        0x0FU
#define LSM_WHO_AM_I_VALUE      0x70U
#define LSM_CTRL1_REG           0x10U
#define LSM_CTRL2_REG           0x11U
#define LSM_CTRL3_REG           0x12U
#define LSM_CTRL6_REG           0x15U
#define LSM_CTRL7_REG           0x16U
#define LSM_CTRL8_REG           0x17U
#define LSM_HAODR_CFG_REG       0x62U
#if FIXED_VQF_SAMPLE_HZ == 2000U
#define LSM_CTRL1_CONFIG        0x1AU /* HAODR high-performance accel, 2 kHz, +/-4 g */
#define LSM_CTRL2_CONFIG        0x1AU /* HAODR high-performance gyro, 2 kHz, +/-2000 dps */
#elif FIXED_VQF_SAMPLE_HZ == 1000U
#define LSM_CTRL1_CONFIG        0x19U /* HAODR high-performance accel, 960 Hz, +/-4 g */
#define LSM_CTRL2_CONFIG        0x19U /* HAODR high-performance gyro, 960 Hz, +/-2000 dps */
#else
#error "FIXED_VQF_SAMPLE_HZ must be 1000 or 2000"
#endif
#define LSM_HAODR_CFG_CONFIG    0x01U /* HAODR_SEL=1: accel and gyro HAODR */
#define LSM_CTRL6_CONFIG         0x44U /* Gyro +/-2000 dps; LPF1 about 101 Hz at HAODR 2 kHz */
#define LSM_CTRL7_CONFIG         0x01U /* LPF1_G_EN=1 */
#define LSM_CTRL8_CONFIG         0x01U /* Accelerometer +/-4 g */
#define LSM_CTRL3_CONFIG        0x44U /* BDU=1, IF_INC=1 for coherent burst reads */
#define LSM_STATUS_REG          0x1EU
#define LSM_OUT_TEMP_L_REG      0x20U
#define LSM_OUTX_L_G_REG        0x22U
#define LSM_OUTX_L_A_REG        0x28U

#define CAN_GYRO_ID             0x301U
#define CAN_ACCEL_ID            0x302U
#define CAN_EULER_ID            0x303U
#define CAN_GYRO_ENABLE         1U
#define CAN_ACCEL_ENABLE        1U
#define CAN_EULER_ENABLE        1U
#define CAN_GYRO_PERIOD_MS      1U
#define CAN_ACCEL_PERIOD_MS     1U
#define CAN_EULER_PERIOD_MS     1U
#define UART_BAUD_RATE          921600U
#define YAW_TEST_SETTLE_SAMPLES (20U * FIXED_VQF_SAMPLE_HZ)
#define YAW_TEST_END_SAMPLES    (80U * FIXED_VQF_SAMPLE_HZ)
#define OUTPUT_RATE_HZ          1000U
#define OUTPUT_DIVIDER          (FIXED_VQF_SAMPLE_HZ / OUTPUT_RATE_HZ)
#define VQF_PERIOD_US           (1000000U / FIXED_VQF_SAMPLE_HZ)
#define VQF_Q30_ONE             0x40000000L
#define YAW_HOLD_RATE_Q24        146409L /* 0.50 deg/s corrected gyro threshold */
#define YAW_REST_HOLD_ENABLE     0U      /* 0=disabled, 1=hold yaw at confirmed rest */

/* These variables can be inspected directly with WCH-Link/GDB. */
volatile uint8_t lsm_test_result = 0;
volatile uint8_t lsm_who_am_i = 0;
volatile uint8_t lsm_ctrl1 = 0;
volatile uint8_t lsm_ctrl2 = 0;
volatile uint8_t lsm_ctrl3 = 0;
volatile uint8_t lsm_ctrl6 = 0;
volatile uint8_t lsm_ctrl7 = 0;
volatile uint8_t lsm_ctrl8 = 0;
volatile uint8_t lsm_haodr_cfg = 0;
volatile uint8_t lsm_status = 0;
volatile uint32_t lsm_data_ready_count = 0U;
volatile uint32_t lsm_data_not_ready_count = 0U;
volatile int16_t lsm_temperature_raw = 0;
volatile int16_t lsm_gyro_x = 0;
volatile int16_t lsm_gyro_y = 0;
volatile int16_t lsm_gyro_z = 0;
volatile int16_t lsm_accel_x = 0;
volatile int16_t lsm_accel_y = 0;
volatile int16_t lsm_accel_z = 0;
/* CAN transmit diagnostics, visible in WCH-Link/GDB. */
volatile uint32_t can_tx_sequence = 0;
volatile uint32_t can_tx_ok_count = 0;
volatile uint32_t can_tx_error_count = 0;
volatile uint8_t can_tx_last_status = CAN_TxStatus_Pending;
volatile uint8_t can_tx_last_mailbox = 0xFFU;
volatile uint8_t can_error_status = 0;
volatile uint32_t uart_tx_frame_count = 0U;
volatile uint32_t uart_tx_dma_busy_count = 0U;
volatile uint32_t can_gyro_tx_count = 0U;
volatile uint32_t can_accel_tx_count = 0U;
volatile uint32_t can_euler_tx_count = 0U;
volatile int32_t vqf_euler_q16[3] = {0, 0, 0}; /* roll, pitch, yaw; Q16.16 degree */
volatile int16_t vqf_euler_cd[3] = {0, 0, 0};  /* CAN-compatible 0.01 degree/LSB */
volatile int32_t yaw_test_start_q16 = 0;
volatile int32_t yaw_test_end_q16 = 0;
volatile int32_t yaw_test_delta_q16 = 0;
volatile int32_t vqf_yaw_raw_q16 = 0;       /* unstabilized 6D VQF yaw for diagnostics */
volatile int32_t yaw_test_raw_start_q16 = 0;
volatile int32_t yaw_test_raw_end_q16 = 0;
volatile int32_t yaw_test_raw_delta_q16 = 0;
volatile uint32_t yaw_rest_hold_count = 0U;
volatile int16_t yaw_test_start_cd = 0;
volatile int16_t yaw_test_end_cd = 0;
volatile int16_t yaw_test_delta_cd = 0;
volatile uint8_t yaw_test_status = 0U; /* 0=settling, 1=measuring, 2=complete */
volatile uint8_t gyro_cal_status = 0U; /* 0=not started, 1=collecting, 2=valid */
volatile int32_t gyro_cal_bias_q16[3] = {0, 0, 0};

volatile float vqf_quat_f32[4] = {1.0f, 0.0f, 0.0f, 0.0f};
volatile int16_t vqf_quat_q15[4] = {32767, 0, 0, 0};
volatile int32_t vqf_quat_q30[4] = {VQF_Q30_ONE, 0, 0, 0};
volatile uint32_t vqf_update_count = 0U;
volatile uint8_t vqf_sample_pending = 0U;
volatile uint32_t vqf_timer_ticks = 0U;
volatile uint32_t vqf_missed_count = 0U;
static uint32_t vqf_sample_count = 0U;
static fixed_vqf_t fixed_vqf;
static int64_t gyro_lpf_state_q54[6] = {0};
static uint8_t gyro_lpf_initialized = 0U;
volatile q24_t vqf_gyro_filtered_q24[3] = {0, 0, 0};
static uint8_t uart2_tx_dma_buffer[16];
extern void TIM2_IRQHandler(void);
/* 1 kHz task execution-time diagnostics. TIM2 counts at 1 MHz, so one count is 1 us. */
volatile uint16_t cpu_busy_us_last = 0U;
volatile uint16_t cpu_busy_us_avg = 0U;
volatile uint16_t cpu_busy_us_max = 0U;
volatile uint16_t cpu_load_permille = 0U; /* Average busy time / sample period, in per mille. */
volatile uint32_t cpu_busy_us_sum = 0U;
volatile uint16_t cpu_busy_samples = 0U;



SLOW_CODE static void VQF_SampleTimer_Init(void)
{
    TIM_TimeBaseInitTypeDef time_base = {0};
    NVIC_InitTypeDef nvic = {0};

    /* At 144 MHz SYSCLK, APB1 is 72 MHz and TIM2 receives the doubled 144 MHz timer clock. */
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_TIM2, ENABLE);
    time_base.TIM_Period = (uint16_t)(VQF_PERIOD_US - 1U);
    time_base.TIM_Prescaler = (uint16_t)((SystemCoreClock / 1000000U) - 1U);
    time_base.TIM_ClockDivision = TIM_CKD_DIV1;
    time_base.TIM_CounterMode = TIM_CounterMode_Up;
    TIM_TimeBaseInit(TIM2, &time_base);
    TIM_ClearITPendingBit(TIM2, TIM_IT_Update);
    TIM_ITConfig(TIM2, TIM_IT_Update, ENABLE);

    nvic.NVIC_IRQChannel = TIM2_IRQn;
    nvic.NVIC_IRQChannelPreemptionPriority = 1U;
    nvic.NVIC_IRQChannelSubPriority = 0U;
    nvic.NVIC_IRQChannelCmd = ENABLE;
    NVIC_Init(&nvic);
    /* VTF slot 0 dispatches TIM2 directly to the WCH fast-interrupt handler.
     * The ISR only acknowledges the timer and posts the fixed-rate VQF task flag. */
    SetVTFIRQ((uint32_t)TIM2_IRQHandler, TIM2_IRQn, 0U, ENABLE);
    TIM_Cmd(TIM2, ENABLE);
}

SLOW_CODE static void CAN1_Init_1M(void)
{
    GPIO_InitTypeDef gpio = {0};
    CAN_InitTypeDef can = {0};

    /* CAN1 default mapping: PA12=TX, PA11=RX. */
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_AFIO | RCC_APB2Periph_GPIOA, ENABLE);
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_CAN1, ENABLE);

    gpio.GPIO_Pin = GPIO_Pin_12;
    gpio.GPIO_Speed = GPIO_Speed_50MHz;
    gpio.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_Init(GPIOA, &gpio);

    gpio.GPIO_Pin = GPIO_Pin_11;
    gpio.GPIO_Mode = GPIO_Mode_IN_FLOATING;
    GPIO_Init(GPIOA, &gpio);

    CAN_DeInit(CAN1);
    CAN_StructInit(&can);
    can.CAN_TTCM = DISABLE;
    can.CAN_ABOM = ENABLE;
    can.CAN_AWUM = DISABLE;
    /* Do not wait for automatic retransmission when a bus peer is absent. */
    can.CAN_NART = ENABLE;
    can.CAN_RFLM = DISABLE;
    can.CAN_TXFP = DISABLE;
    can.CAN_Mode = CAN_Mode_Normal;
    can.CAN_SJW = CAN_SJW_1tq;
    can.CAN_BS1 = CAN_BS1_14tq;
    can.CAN_BS2 = CAN_BS2_3tq;
    can.CAN_Prescaler = 4U; /* 72 MHz PCLK1 / (4 * 18 tq) = 1 Mbit/s at 144 MHz SYSCLK. */

    if(CAN_Init(CAN1, &can) != CAN_InitStatus_Success)
    {
        can_error_status = 0xE0U;
    }
}

SLOW_CODE static void UART2_Init_921600(void)
{
    GPIO_InitTypeDef gpio = {0};
    USART_InitTypeDef uart = {0};

    /* USART2 default mapping: PA2=TX, PA3=RX. */
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_USART2, ENABLE);
    gpio.GPIO_Pin = GPIO_Pin_2;
    gpio.GPIO_Speed = GPIO_Speed_50MHz;
    gpio.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_Init(GPIOA, &gpio);
    gpio.GPIO_Pin = GPIO_Pin_3;
    gpio.GPIO_Mode = GPIO_Mode_IN_FLOATING;
    GPIO_Init(GPIOA, &gpio);

    uart.USART_BaudRate = UART_BAUD_RATE;
    uart.USART_WordLength = USART_WordLength_8b;
    uart.USART_StopBits = USART_StopBits_1;
    uart.USART_Parity = USART_Parity_No;
    uart.USART_HardwareFlowControl = USART_HardwareFlowControl_None;
    uart.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    USART_Init(USART2, &uart);
    USART_Cmd(USART2, ENABLE);

    /* DMA1 channel 7 is USART2_TX. The 16-byte JustFloat frame then costs
     * only a short memory fill in the 500 us fusion slot instead of ~174 us
     * of polling at 921600 baud. */
    {
        DMA_InitTypeDef dma = {0};
        RCC_AHBPeriphClockCmd(RCC_AHBPeriph_DMA1, ENABLE);
        DMA_DeInit(DMA1_Channel7);
        dma.DMA_PeripheralBaseAddr = (uint32_t)&USART2->DATAR;
        dma.DMA_MemoryBaseAddr = (uint32_t)uart2_tx_dma_buffer;
        dma.DMA_DIR = DMA_DIR_PeripheralDST;
        dma.DMA_BufferSize = sizeof(uart2_tx_dma_buffer);
        dma.DMA_PeripheralInc = DMA_PeripheralInc_Disable;
        dma.DMA_MemoryInc = DMA_MemoryInc_Enable;
        dma.DMA_PeripheralDataSize = DMA_PeripheralDataSize_Byte;
        dma.DMA_MemoryDataSize = DMA_MemoryDataSize_Byte;
        dma.DMA_Mode = DMA_Mode_Normal;
        dma.DMA_Priority = DMA_Priority_High;
        dma.DMA_M2M = DMA_M2M_Disable;
        DMA_Init(DMA1_Channel7, &dma);
        /* DMA_Init loads CNTR with BufferSize even while the channel is disabled.
         * Mark it idle so the first 1 kHz frame is allowed to start. */
        DMA_SetCurrDataCounter(DMA1_Channel7, 0U);
        USART_DMACmd(USART2, USART_DMAReq_Tx, ENABLE);
    }
}

static int32_t VQF_Q30_Mul2(int32_t a, int32_t b)
{
    int64_t value = ((int64_t)a * (int64_t)b) >> 29;
    if(value > 2147483647LL) value = 2147483647LL;
    if(value < -2147483648LL) value = -2147483648LL;
    return (int32_t)value;
}

static uint32_t VQF_ISqrt64(uint64_t value)
{
    uint64_t bit = (uint64_t)1U << 62;
    uint64_t result = 0U;
    while(bit > value) bit >>= 2;
    while(bit != 0U)
    {
        if(value >= result + bit)
        {
            value -= result + bit;
            result = (result >> 1) + bit;
        }
        else result >>= 1;
        bit >>= 2;
    }
    return (uint32_t)result;
}

/* atan2 CORDIC with a Q16.16 degree accumulator. The previous centidegree
 * table quantized every Euler result before UART transmission. 23 useful
 * iterations make the final CORDIC step one Q16.16 degree LSB; total
 * conversion error remains comfortably below 0.001 degree for normalized inputs. */
static int32_t VQF_Atan2_DegQ16(int32_t y_in, int32_t x_in)
{
    static const int32_t atan_deg_q16[23] = {
        2949120, 1740967, 919879, 466945, 234379, 117304,
        58666, 29335, 14668, 7334, 3667, 1833, 917, 458,
        229, 115, 57, 29, 14, 7, 4, 2, 1
    };
    int32_t x = x_in >> 2;
    int32_t y = y_in >> 2;
    int32_t angle_q16 = 0;
    uint8_t i;

    if((x == 0) && (y == 0)) return 0;
    if(x < 0)
    {
        angle_q16 = (y >= 0) ? (180L << 16) : -(180L << 16);
        x = -x;
        y = -y;
    }
    for(i = 0U; i < 23U; i++)
    {
        int32_t old_x;
        if(y == 0) break;
        old_x = x;
        if(y > 0)
        {
            x += y >> i;
            y -= old_x >> i;
            angle_q16 += atan_deg_q16[i];
        }
        else
        {
            x -= y >> i;
            y += old_x >> i;
            angle_q16 -= atan_deg_q16[i];
        }
    }
    if(angle_q16 > (180L << 16)) angle_q16 -= (360L << 16);
    if(angle_q16 < -(180L << 16)) angle_q16 += (360L << 16);
    return angle_q16;
}

static int16_t VQF_DegQ16_ToCentiDeg(int32_t angle_q16)
{
    int64_t scaled = (int64_t)angle_q16 * 100;
    if(scaled >= 0) scaled += 32768;
    else scaled -= 32768;
    return (int16_t)(scaled / 65536);
}

static uint8_t VQF_GyroRateNearZero(void)
{
    uint8_t i;
    for(i = 0U; i < 3U; i++)
    {
        int64_t corrected = (int64_t)vqf_gyro_filtered_q24[i] -
                            ((int64_t)gyro_cal_bias_q16[i] * 256LL);
        if(corrected > YAW_HOLD_RATE_Q24 || corrected < -YAW_HOLD_RATE_Q24) return 0U;
    }
    return 1U;
}
static int32_t VQF_WrapDeltaDegQ16(int32_t delta_q16);

static void VQF_UpdateEuler(const int32_t q[4])
{
    int32_t r00 = VQF_Q30_ONE - VQF_Q30_Mul2(q[2], q[2]) - VQF_Q30_Mul2(q[3], q[3]);
    int32_t r10 = VQF_Q30_Mul2(q[1], q[2]) + VQF_Q30_Mul2(q[0], q[3]);
    int32_t r20 = VQF_Q30_Mul2(q[1], q[3]) - VQF_Q30_Mul2(q[0], q[2]);
    int32_t r21 = VQF_Q30_Mul2(q[2], q[3]) + VQF_Q30_Mul2(q[0], q[1]);
    int32_t r22 = VQF_Q30_ONE - VQF_Q30_Mul2(q[1], q[1]) - VQF_Q30_Mul2(q[2], q[2]);
    uint64_t horizontal_sq = (uint64_t)((int64_t)r00 * r00) +
                             (uint64_t)((int64_t)r10 * r10);
    int32_t horizontal = (int32_t)VQF_ISqrt64(horizontal_sq);

    vqf_euler_q16[0] = VQF_Atan2_DegQ16(r21, r22);
    vqf_euler_q16[1] = VQF_Atan2_DegQ16(-r20, horizontal);
    vqf_yaw_raw_q16 = VQF_Atan2_DegQ16(r10, r00);
    {
        static int32_t yaw_offset_q16 = 0;
        static int32_t yaw_held_q16 = 0;
        static uint8_t yaw_initialized = 0U;
        int32_t yaw_out;

        if(yaw_initialized == 0U)
        {
            yaw_held_q16 = vqf_yaw_raw_q16;
            yaw_initialized = 1U;
        }

        if(YAW_REST_HOLD_ENABLE &&
           fixed_vqf_get_rest_detected(&fixed_vqf) &&
           VQF_GyroRateNearZero())
        {
            /* Heading is unobservable without a magnetometer. During confirmed
             * rest, hold the last output heading and continuously update the
             * offset to the raw 6D quaternion. Motion resumes without a jump. */
            yaw_offset_q16 = VQF_WrapDeltaDegQ16(yaw_held_q16 - vqf_yaw_raw_q16);
            yaw_out = yaw_held_q16;
            yaw_rest_hold_count++;
        }
        else
        {
            yaw_out = VQF_WrapDeltaDegQ16(vqf_yaw_raw_q16 + yaw_offset_q16);
            yaw_held_q16 = yaw_out;
        }
        vqf_euler_q16[2] = yaw_out;
    }

    /* Preserve the existing Damiao-compatible CAN payload resolution. */
    vqf_euler_cd[0] = VQF_DegQ16_ToCentiDeg(vqf_euler_q16[0]);
    vqf_euler_cd[1] = VQF_DegQ16_ToCentiDeg(vqf_euler_q16[1]);
    vqf_euler_cd[2] = VQF_DegQ16_ToCentiDeg(vqf_euler_q16[2]);
}

static int32_t VQF_WrapDeltaDegQ16(int32_t delta_q16)
{
    while(delta_q16 > (180L << 16)) delta_q16 -= (360L << 16);
    while(delta_q16 < -(180L << 16)) delta_q16 += (360L << 16);
    return delta_q16;
}

static int16_t VQF_Q30_To_Q15(int32_t value)
{
    int32_t q = value >> 15;
    if(q > 32767) q = 32767;
    if(q < -32768) q = -32768;
    return (int16_t)q;
}

/* 80 Hz second-order Butterworth software LPF. Together with the sensor's
 * 101 Hz LPF1 this removes high-frequency rate noise while keeping only a
 * few milliseconds of delay for attitude motion. */
static int32_t VQF_RoundShift30(int64_t value)
{
    if(value >= 0) value += (1LL << 29);
    else value -= (1LL << 29);
    value /= (1LL << 30);
    if(value > 2147483647LL) value = 2147483647LL;
    if(value < -2147483648LL) value = -2147483648LL;
    return (int32_t)value;
}

/* Feedback from the full precision DF-II state.  Multiplying a Q30
 * coefficient directly by the Q54 state would overflow 64 bits; split the
 * state into its integer and remainder parts instead. */
static int64_t VQF_Q30MulState(int32_t coefficient, int64_t state_q54)
{
    int64_t state_q24 = state_q54 / (1LL << 30);
    int64_t remainder = state_q54 - state_q24 * (1LL << 30);
    return (int64_t)coefficient * state_q24 +
           (int64_t)VQF_RoundShift30((int64_t)coefficient * remainder);
}

static void VQF_GyroSoftwareLPF(const q24_t input[3], q24_t output[3])
{
#if FIXED_VQF_SAMPLE_HZ == 2000U
    static const int32_t b[3] = {14344332, 28688664, 14344332};
    static const int32_t a[2] = {-1768946685, 752582188};
#else
    static const int32_t b[3] = {49533645, 99067291, 49533645};
    static const int32_t a[2] = {-1403686611, 528079369};
#endif
    uint8_t i;

    if(gyro_lpf_initialized == 0U)
    {
        for(i = 0U; i < 3U; i++)
        {
            gyro_lpf_state_q54[2U*i] = (int64_t)input[i] * (VQF_Q30_ONE - b[0]);
            gyro_lpf_state_q54[2U*i+1U] = (int64_t)input[i] * (b[2] - a[1]);
            output[i] = input[i];
        }
        gyro_lpf_initialized = 1U;
        return;
    }

    for(i = 0U; i < 3U; i++)
    {
        int64_t y54 = (int64_t)b[0] * input[i] + gyro_lpf_state_q54[2U*i];
        int32_t y = VQF_RoundShift30(y54);
        gyro_lpf_state_q54[2U*i] = (int64_t)b[1] * input[i] -
                                    VQF_Q30MulState(a[0], y54) + gyro_lpf_state_q54[2U*i+1U];
        gyro_lpf_state_q54[2U*i+1U] = (int64_t)b[2] * input[i] - VQF_Q30MulState(a[1], y54);
        output[i] = y;
    }
}

static void VQF_UpdateFromLSM6DSV(uint8_t update_output)
{
    q24_t gyro_q24[3];
    q30_t accel_q30[3];
    q30_t quat_q30[4];
    int32_t bias_q16[3];
    uint8_t i;

    /* No software floating point in the 1 kHz path. The RV32 M extension
     * executes the 32x32->64 products used by the fixed-point conversion. */
    gyro_q24[0] = fixed_vqf_gyro_raw_to_q24(lsm_gyro_x);
    gyro_q24[1] = fixed_vqf_gyro_raw_to_q24(lsm_gyro_y);
    gyro_q24[2] = fixed_vqf_gyro_raw_to_q24(lsm_gyro_z);
    /* +/-4 g, raw/8192 g -> Q1.30 is exactly raw << 17. */
    accel_q30[0] = (q30_t)((int32_t)lsm_accel_x * 131072L);
    accel_q30[1] = (q30_t)((int32_t)lsm_accel_y * 131072L);
    accel_q30[2] = (q30_t)((int32_t)lsm_accel_z * 131072L);

    VQF_GyroSoftwareLPF(gyro_q24, gyro_q24);
    vqf_gyro_filtered_q24[0] = gyro_q24[0];
    vqf_gyro_filtered_q24[1] = gyro_q24[1];
    vqf_gyro_filtered_q24[2] = gyro_q24[2];
    fixed_vqf_update_gyr(&fixed_vqf, gyro_q24);
    fixed_vqf_update_acc(&fixed_vqf, accel_q30);
    fixed_vqf_get_q30(&fixed_vqf, quat_q30);
    fixed_vqf_get_bias_q16(&fixed_vqf, bias_q16);

    gyro_cal_status = fixed_vqf_get_rest_detected(&fixed_vqf) ? 2U : 1U;
    for(i = 0U; i < 3U; i++) gyro_cal_bias_q16[i] = bias_q16[i];
    for(i = 0U; i < 4U; i++)
    {
        vqf_quat_q30[i] = quat_q30[i];
        vqf_quat_q15[i] = VQF_Q30_To_Q15(quat_q30[i]);
    }
    vqf_sample_count++;
    vqf_update_count++;
    if(update_output != 0U)
    {
        /* Euler conversion and communications remain at 1 kHz while the
         * quaternion and Full VQF state update at FIXED_VQF_SAMPLE_HZ. */
        VQF_UpdateEuler(quat_q30);
        if(vqf_update_count == YAW_TEST_SETTLE_SAMPLES)
        {
            yaw_test_start_q16 = vqf_euler_q16[2];
            yaw_test_raw_start_q16 = vqf_yaw_raw_q16;
            yaw_test_start_cd = vqf_euler_cd[2];
            yaw_test_status = 1U;
        }
        else if(vqf_update_count == YAW_TEST_END_SAMPLES)
        {
            yaw_test_end_q16 = vqf_euler_q16[2];
            yaw_test_delta_q16 = VQF_WrapDeltaDegQ16(yaw_test_end_q16 - yaw_test_start_q16);
            yaw_test_raw_end_q16 = vqf_yaw_raw_q16;
            yaw_test_raw_delta_q16 = VQF_WrapDeltaDegQ16(yaw_test_raw_end_q16 - yaw_test_raw_start_q16);
            yaw_test_end_cd = vqf_euler_cd[2];
            yaw_test_delta_cd = VQF_DegQ16_ToCentiDeg(yaw_test_delta_q16);
            yaw_test_status = 2U;
        }
    }
}
static void CAN1_SendDamiaoFrame(uint16_t id, uint8_t reg, int16_t x, int16_t y, int16_t z)
{
    CanTxMsg message = {0};
    uint8_t mailbox;

    message.StdId = id;
    message.ExtId = 0U;
    message.IDE = CAN_Id_Standard;
    message.RTR = CAN_RTR_Data;
    message.DLC = 8U;
    message.Data[0] = reg;
    message.Data[1] = 0U;
    message.Data[2] = (uint8_t)x;
    message.Data[3] = (uint8_t)((uint16_t)x >> 8);
    message.Data[4] = (uint8_t)y;
    message.Data[5] = (uint8_t)((uint16_t)y >> 8);
    message.Data[6] = (uint8_t)z;
    message.Data[7] = (uint8_t)((uint16_t)z >> 8);

    mailbox = CAN_Transmit(CAN1, &message);
    can_tx_last_mailbox = mailbox;
    can_tx_last_status = CAN_TxStatus_Pending;
    if(mailbox == CAN_TxStatus_NoMailBox)
    {
        can_tx_error_count++;
        can_tx_last_status = CAN_TxStatus_NoMailBox;
        can_error_status = CAN1->ERRSR;
    }
    else can_tx_ok_count++;
    can_tx_sequence++;
}

static int16_t LSM_GyroToCentiDps(int16_t raw)
{
    /* +/-2000 dps, 70 mdps/LSB => 7 centi-dps/LSB. */
    return (int16_t)((int32_t)raw * 7);
}

static int16_t LSM_AccelToMg(int16_t raw)
{
    /* +/-4 g, 8192 LSB/g => 0.122070 mg/LSB. */
    return (int16_t)(((int32_t)raw * 125) / 1024);
}

static void CAN1_Service(uint16_t elapsed_ms)
{
    static uint16_t gyro_elapsed = 0U;
    static uint16_t accel_elapsed = 0U;
    static uint16_t euler_elapsed = 0U;
    int16_t x, y, z;

    gyro_elapsed = (uint16_t)(gyro_elapsed + elapsed_ms);
    accel_elapsed = (uint16_t)(accel_elapsed + elapsed_ms);
    euler_elapsed = (uint16_t)(euler_elapsed + elapsed_ms);

    if(CAN_GYRO_ENABLE && (gyro_elapsed >= CAN_GYRO_PERIOD_MS))
    {
        gyro_elapsed = (uint16_t)(gyro_elapsed - CAN_GYRO_PERIOD_MS);
        CAN1_SendDamiaoFrame(CAN_GYRO_ID, 2U,
                             LSM_GyroToCentiDps(lsm_gyro_x),
                             LSM_GyroToCentiDps(lsm_gyro_y),
                             LSM_GyroToCentiDps(lsm_gyro_z));
        can_gyro_tx_count++;
    }
    if(CAN_ACCEL_ENABLE && (accel_elapsed >= CAN_ACCEL_PERIOD_MS))
    {
        accel_elapsed = (uint16_t)(accel_elapsed - CAN_ACCEL_PERIOD_MS);
        CAN1_SendDamiaoFrame(CAN_ACCEL_ID, 1U,
                             LSM_AccelToMg(lsm_accel_x),
                             LSM_AccelToMg(lsm_accel_y),
                             LSM_AccelToMg(lsm_accel_z));
        can_accel_tx_count++;
    }
    if(CAN_EULER_ENABLE && (euler_elapsed >= CAN_EULER_PERIOD_MS))
    {
        euler_elapsed = (uint16_t)(euler_elapsed - CAN_EULER_PERIOD_MS);
        /* Damiao order: Pitch, Yaw, Roll; unit here is 0.01 degree. */
        x = vqf_euler_cd[1];
        y = vqf_euler_cd[2];
        z = vqf_euler_cd[0];
        CAN1_SendDamiaoFrame(CAN_EULER_ID, 3U, x, y, z);
        can_euler_tx_count++;
    }
}

static void UART2_PackFloatLE(uint8_t *dst, float value)
{
    union { float f; uint8_t b[4]; } data;
    data.f = value;
    dst[0] = data.b[0];
    dst[1] = data.b[1];
    dst[2] = data.b[2];
    dst[3] = data.b[3];
}

static void UART2_SendEulerJustFloat(void)
{
    if(DMA_GetCurrDataCounter(DMA1_Channel7) != 0U)
    {
        uart_tx_dma_busy_count++;
        return;
    }

    UART2_PackFloatLE(&uart2_tx_dma_buffer[0], (float)vqf_euler_q16[0] / 65536.0f);
    UART2_PackFloatLE(&uart2_tx_dma_buffer[4], (float)vqf_euler_q16[1] / 65536.0f);
    UART2_PackFloatLE(&uart2_tx_dma_buffer[8], (float)vqf_euler_q16[2] / 65536.0f);
    uart2_tx_dma_buffer[12] = 0x00U;
    uart2_tx_dma_buffer[13] = 0x00U;
    uart2_tx_dma_buffer[14] = 0x80U;
    uart2_tx_dma_buffer[15] = 0x7FU;

    DMA_Cmd(DMA1_Channel7, DISABLE);
    DMA_ClearFlag(DMA1_FLAG_GL7);
    DMA1_Channel7->MADDR = (uint32_t)uart2_tx_dma_buffer;
    DMA_SetCurrDataCounter(DMA1_Channel7, sizeof(uart2_tx_dma_buffer));
    DMA_Cmd(DMA1_Channel7, ENABLE);
    uart_tx_frame_count++;
}

SLOW_CODE static void Status_LED_Init(void)
{
    GPIO_InitTypeDef gpio = {0};
    TIM_TimeBaseInitTypeDef time_base = {0};
    TIM_OCInitTypeDef output_compare = {0};

    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA | RCC_APB2Periph_TIM1, ENABLE);

    gpio.GPIO_Pin = GPIO_Pin_9;
    gpio.GPIO_Speed = GPIO_Speed_50MHz;
    gpio.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_Init(GPIOA, &gpio);

    time_base.TIM_Period = BREATH_PWM_PERIOD;
    time_base.TIM_Prescaler = (uint16_t)((SystemCoreClock / 1000000U) - 1U);
    time_base.TIM_ClockDivision = TIM_CKD_DIV1;
    time_base.TIM_CounterMode = TIM_CounterMode_Up;
    TIM_TimeBaseInit(TIM1, &time_base);

    output_compare.TIM_OCMode = TIM_OCMode_PWM1;
    output_compare.TIM_OutputState = TIM_OutputState_Enable;
    output_compare.TIM_Pulse = 0;
    output_compare.TIM_OCPolarity = TIM_OCPolarity_High;
    TIM_OC2Init(TIM1, &output_compare);
    TIM_OC2PreloadConfig(TIM1, TIM_OCPreload_Enable);
    TIM_ARRPreloadConfig(TIM1, ENABLE);
    TIM_CtrlPWMOutputs(TIM1, ENABLE);
    TIM_Cmd(TIM1, ENABLE);
}

SLOW_CODE static void LSM6DSV_SPI_Init(void)
{
    GPIO_InitTypeDef gpio = {0};
    SPI_InitTypeDef spi = {0};

    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA | RCC_APB2Periph_SPI1, ENABLE);

    /* Drive CS high before enabling SPI. */
    gpio.GPIO_Pin = LSM_CS_PIN;
    gpio.GPIO_Speed = GPIO_Speed_50MHz;
    gpio.GPIO_Mode = GPIO_Mode_Out_PP;
    GPIO_Init(LSM_CS_PORT, &gpio);
    GPIO_SetBits(LSM_CS_PORT, LSM_CS_PIN);

    /* PA5=SCK and PA7=MOSI. */
    gpio.GPIO_Pin = GPIO_Pin_5 | GPIO_Pin_7;
    gpio.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_Init(GPIOA, &gpio);

    /* PA6=MISO. */
    gpio.GPIO_Pin = GPIO_Pin_6;
    gpio.GPIO_Mode = GPIO_Mode_IN_FLOATING;
    GPIO_Init(GPIOA, &gpio);

    /* LSM6DSV supports SPI mode 0 and mode 3; use mode 3 here. */
    spi.SPI_Direction = SPI_Direction_2Lines_FullDuplex;
    spi.SPI_Mode = SPI_Mode_Master;
    spi.SPI_DataSize = SPI_DataSize_8b;
    spi.SPI_CPOL = SPI_CPOL_High;
    spi.SPI_CPHA = SPI_CPHA_2Edge;
    spi.SPI_NSS = SPI_NSS_Soft;
    spi.SPI_BaudRatePrescaler = SPI_BaudRatePrescaler_16; /* 9 MHz, below the 10 MHz sensor limit. */
    spi.SPI_FirstBit = SPI_FirstBit_MSB;
    spi.SPI_CRCPolynomial = 7;
    SPI_Init(SPI1, &spi);
    SPI_Cmd(SPI1, ENABLE);
}

static uint8_t SPI1_Transfer(uint8_t data)
{
    uint32_t timeout = 100000U;

    while((SPI_I2S_GetFlagStatus(SPI1, SPI_I2S_FLAG_TXE) == RESET) && (timeout > 0U))
    {
        timeout--;
    }
    SPI_I2S_SendData(SPI1, data);

    timeout = 100000U;
    while((SPI_I2S_GetFlagStatus(SPI1, SPI_I2S_FLAG_RXNE) == RESET) && (timeout > 0U))
    {
        timeout--;
    }
    return (uint8_t)SPI_I2S_ReceiveData(SPI1);
}

static uint8_t LSM6DSV_ReadReg(uint8_t reg)
{
    uint8_t value;

    GPIO_ResetBits(LSM_CS_PORT, LSM_CS_PIN);
    SPI1_Transfer((uint8_t)(reg | 0x80U));
    value = SPI1_Transfer(0xFFU);
    GPIO_SetBits(LSM_CS_PORT, LSM_CS_PIN);
    return value;
}

static void LSM6DSV_WriteReg(uint8_t reg, uint8_t value)
{
    GPIO_ResetBits(LSM_CS_PORT, LSM_CS_PIN);
    SPI1_Transfer((uint8_t)(reg & 0x7FU));
    SPI1_Transfer(value);
    GPIO_SetBits(LSM_CS_PORT, LSM_CS_PIN);
}

static void LSM6DSV_ReadBurst(uint8_t start_reg, uint8_t *data, uint8_t length)
{
    uint8_t i;
    GPIO_ResetBits(LSM_CS_PORT, LSM_CS_PIN);
    SPI1_Transfer((uint8_t)(start_reg | 0x80U));
    for(i = 0U; i < length; i++) data[i] = SPI1_Transfer(0xFFU);
    GPIO_SetBits(LSM_CS_PORT, LSM_CS_PIN);
}

static int16_t LSM6DSV_Pack16(const uint8_t *data)
{
    return (int16_t)(((uint16_t)data[1] << 8) | data[0]);
}

static uint8_t LSM6DSV_UpdateData(void)
{
    uint8_t data[14];
    lsm_status = LSM6DSV_ReadReg(LSM_STATUS_REG);
    if((lsm_status & 0x03U) == 0x03U) lsm_data_ready_count++;
    else {
        lsm_data_not_ready_count++;
        return 0U;
    }
    /* One burst: temperature (2), gyro XYZ (6), accel XYZ (6). */
    LSM6DSV_ReadBurst(LSM_OUT_TEMP_L_REG, data, 14U);
    lsm_temperature_raw = LSM6DSV_Pack16(&data[0]);
    lsm_gyro_x = LSM6DSV_Pack16(&data[2]);
    lsm_gyro_y = LSM6DSV_Pack16(&data[4]);
    lsm_gyro_z = LSM6DSV_Pack16(&data[6]);
    lsm_accel_x = LSM6DSV_Pack16(&data[8]);
    lsm_accel_y = LSM6DSV_Pack16(&data[10]);
    lsm_accel_z = LSM6DSV_Pack16(&data[12]);
    return 1U;
}

SLOW_CODE static void LSM6DSV_Test(void)
{
    int32_t accel_activity;

    Delay_Ms(20);
    lsm_who_am_i = LSM6DSV_ReadReg(LSM_WHO_AM_I_REG);
    if(lsm_who_am_i != LSM_WHO_AM_I_VALUE)
    {
        lsm_test_result = 0xE1U; /* SPI/device ID failure. */
        return;
    }

    /* ST HAODR transition sequence: power down both channels, select HAODR,
     * start the gyroscope, wait at least 20 us, then start the accelerometer. */
    LSM6DSV_WriteReg(LSM_CTRL3_REG, LSM_CTRL3_CONFIG);
    LSM6DSV_WriteReg(LSM_CTRL1_REG, 0x00U);
    LSM6DSV_WriteReg(LSM_CTRL2_REG, 0x00U);
    LSM6DSV_WriteReg(LSM_HAODR_CFG_REG, LSM_HAODR_CFG_CONFIG);
    LSM6DSV_WriteReg(LSM_CTRL2_REG, LSM_CTRL2_CONFIG);
    Delay_Ms(1);
    LSM6DSV_WriteReg(LSM_CTRL1_REG, LSM_CTRL1_CONFIG);
    LSM6DSV_WriteReg(LSM_CTRL6_REG, LSM_CTRL6_CONFIG);
    LSM6DSV_WriteReg(LSM_CTRL7_REG, LSM_CTRL7_CONFIG);
    LSM6DSV_WriteReg(LSM_CTRL8_REG, LSM_CTRL8_CONFIG);
    Delay_Ms(40);
    lsm_ctrl1 = LSM6DSV_ReadReg(LSM_CTRL1_REG);
    lsm_ctrl2 = LSM6DSV_ReadReg(LSM_CTRL2_REG);
    lsm_ctrl3 = LSM6DSV_ReadReg(LSM_CTRL3_REG);
    lsm_ctrl6 = LSM6DSV_ReadReg(LSM_CTRL6_REG);
    lsm_ctrl7 = LSM6DSV_ReadReg(LSM_CTRL7_REG);
    lsm_ctrl8 = LSM6DSV_ReadReg(LSM_CTRL8_REG);
    lsm_haodr_cfg = LSM6DSV_ReadReg(LSM_HAODR_CFG_REG);
    if((lsm_ctrl1 != LSM_CTRL1_CONFIG) || (lsm_ctrl2 != LSM_CTRL2_CONFIG) ||
       ((lsm_ctrl3 & LSM_CTRL3_CONFIG) != LSM_CTRL3_CONFIG) ||
       (lsm_ctrl6 != LSM_CTRL6_CONFIG) ||
       ((lsm_ctrl7 & 0x01U) != LSM_CTRL7_CONFIG) ||
       ((lsm_ctrl8 & 0x03U) != LSM_CTRL8_CONFIG) ||
       ((lsm_haodr_cfg & 0x03U) != LSM_HAODR_CFG_CONFIG))
    {
        lsm_test_result = 0xE2U; /* Register write/readback failure. */
        return;
    }

    Delay_Ms(100);
    LSM6DSV_UpdateData();
    accel_activity = (lsm_accel_x < 0) ? -(int32_t)lsm_accel_x : lsm_accel_x;
    accel_activity += (lsm_accel_y < 0) ? -(int32_t)lsm_accel_y : lsm_accel_y;
    accel_activity += (lsm_accel_z < 0) ? -(int32_t)lsm_accel_z : lsm_accel_z;

    if((accel_activity < 500) ||
       ((lsm_accel_x == -1) && (lsm_accel_y == -1) && (lsm_accel_z == -1)))
    {
        lsm_test_result = 0xE3U; /* Output data is not plausible. */
        return;
    }

    lsm_test_result = 3U; /* ID, configuration and live data all passed. */
}

int main(void)
{
    uint16_t brightness = 0;
    int16_t step = 2;
    uint16_t cpu_start_us;
    uint16_t cpu_end_us;
    uint16_t cpu_busy_us;
    uint8_t output_phase = 0U;
    uint8_t output_due;

    NVIC_PriorityGroupConfig(NVIC_PriorityGroup_1);
    SystemCoreClockUpdate();
    Delay_Init();
    Status_LED_Init();
    LSM6DSV_SPI_Init();
    LSM6DSV_Test();
    CAN1_Init_1M();
    UART2_Init_921600();
    fixed_vqf_init(&fixed_vqf);
    VQF_SampleTimer_Init();

    while(1)
    {
        if(lsm_test_result == 3U)
        {
            /* TIM2 supplies the fixed 0.5 ms cadence for the 2 kHz VQF. */
            if(vqf_sample_pending == 0U) continue;
            vqf_sample_pending = 0U;
            cpu_start_us = (uint16_t)TIM2->CNT;

            output_phase++;
            output_due = 0U;
            if(output_phase >= OUTPUT_DIVIDER)
            {
                output_phase = 0U;
                output_due = 1U;
            }

            if(LSM6DSV_UpdateData() == 0U)
            {
                vqf_missed_count++;
                continue;
            }
            VQF_UpdateFromLSM6DSV(output_due);
            if(output_due != 0U)
            {
                CAN1_Service(1U);
                UART2_SendEulerJustFloat();
                TIM_SetCompare2(TIM1, brightness);
                if((step > 0) && (brightness >= (BREATH_PWM_PERIOD - 2U)))
                {
                    step = -2;
                }
                else if((step < 0) && (brightness <= 2U))
                {
                    step = 2;
                }
                brightness = (uint16_t)((int32_t)brightness + step);
            }

            cpu_end_us = (uint16_t)TIM2->CNT;
            if(cpu_end_us >= cpu_start_us)
            {
                cpu_busy_us = (uint16_t)(cpu_end_us - cpu_start_us);
            }
            else
            {
                cpu_busy_us = (uint16_t)(VQF_PERIOD_US + cpu_end_us - cpu_start_us);
            }

            cpu_busy_us_last = cpu_busy_us;
            if(cpu_busy_us > cpu_busy_us_max) cpu_busy_us_max = cpu_busy_us;
            cpu_busy_us_sum += cpu_busy_us;
            cpu_busy_samples++;
            if(cpu_busy_samples >= FIXED_VQF_SAMPLE_HZ)
            {
                cpu_busy_us_avg = (uint16_t)(cpu_busy_us_sum / cpu_busy_samples);
                cpu_load_permille = (uint16_t)(((uint32_t)cpu_busy_us_avg * 1000U) / VQF_PERIOD_US);
                cpu_busy_us_sum = 0U;
                cpu_busy_samples = 0U;
            }

        }
        else
        {
            /* Sensor failure: fast LED blink while CAN remains active. */
            TIM_SetCompare2(TIM1, BREATH_PWM_PERIOD);
            Delay_Ms(100);
            CAN1_Service(100U);
            TIM_SetCompare2(TIM1, 0);
            Delay_Ms(100);
            CAN1_Service(100U);
        }
    }
}



