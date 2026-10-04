#pragma once
#include <stdint.h>
#include <limits.h>

/* Arithmetic right shift, explicitly rounding toward negative infinity.
 * Callers use shift < bit width. Unsigned complement handles INT_MIN. */
static inline int32_t imu_asr32(int32_t value, uint8_t shift)
{
    return value >= 0 ? (int32_t)((uint32_t)value >> shift) :
           -1 - (int32_t)(~(uint32_t)value >> shift);
}

static inline int64_t imu_asr64(int64_t value, uint8_t shift)
{
    return value >= 0 ? (int64_t)((uint64_t)value >> shift) :
           -1 - (int64_t)(~(uint64_t)value >> shift);
}

/* Pure conversion helpers, shared by the firmware and host boundary tests. */
static inline int32_t imu_accel_raw_to_q30(int16_t raw, int32_t scale,
                                           uint8_t *saturated)
{
    int64_t value = (int64_t)raw * scale;
    *saturated = 0U;
    if(value > INT32_MAX) { *saturated = 1U; return INT32_MAX; }
    if(value < INT32_MIN) { *saturated = 1U; return INT32_MIN; }
    return (int32_t)value;
}

static inline int16_t imu_gyro_raw_to_centidps(int16_t raw, uint8_t fs_2000,
                                                uint8_t *saturated)
{
    int32_t value = fs_2000 ? (int32_t)raw * 7 : ((int32_t)raw * 7) / 16;
    *saturated = 0U;
    if(value > INT16_MAX) { *saturated = 1U; return INT16_MAX; }
    if(value < INT16_MIN) { *saturated = 1U; return INT16_MIN; }
    return (int16_t)value;
}
