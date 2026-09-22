#pragma once

#include <stdbool.h>
#include <stdint.h>

/* Fixed VQF and sensor sampling frequency. Supported: 1000 or 2000 Hz. */
#define FIXED_VQF_SAMPLE_HZ     2000U

/* Sensor full-scale options; defaults preserve the original ranges. */
#define LSM6DSV_GYRO_FS_2000DPS 0U /* 0: +/-125 dps, 1: +/-2000 dps */
#define LSM6DSV_ACCEL_FS_4G     0U /* 0: +/-2 g,    1: +/-4 g */

/* Keep the fixed-point estimator on the same bias-estimation configuration
 * as the current float VQF instance: rest bias enabled, motion bias disabled. */
#define FIXED_VQF_MOTION_BIAS_ENABLED 1U
#define FIXED_VQF_REST_BIAS_ENABLED   1U
#define FIXED_VQF_BIAS_SIGMA_REST_DPS 0.03f

/*
 * Fixed-point Full-VQF (6D, no magnetometer) numeric formats.
 *
 * q30_t: Q1.30 quaternion, unit vectors, rotation matrices and Kalman gains.
 * q24_t: Q7.24 sensor angular-rate input in rad/s.
 * Gyro bias is accumulated internally as signed Q31.32 in int64_t. One bias
 * LSB is 2.33e-10 rad/s = 0.0000008 deg/min.
 * q20 covariance values are stored in int64_t to retain the 0.001/sample
 * process-noise increment and the very large vertical motion noise.
 * Biquad states retain the full product precision (Q60 / Q54).
 */
typedef int32_t q30_t;
typedef int32_t q24_t;

typedef struct {
    q30_t gyr_q[4];
    q30_t acc_q[4];
    int64_t gyro_bias_q32[3];

    /* Full-precision Direct Form II transposed filter state. */
    int64_t rest_gyr_state_q54[6];
    int64_t rest_acc_state_q60[6];
    int64_t acc_lp_state_q60[6];
    int64_t motion_R_state_q60[18];
    int64_t motion_bias_state_q62[4];

    q24_t rest_last_gyr_q24[3];
    q30_t rest_last_acc_q30[3];
    q30_t last_acc_lp_q30[3];

    /* Covariance units match Full VQF, with 20 fractional bits. */
    int64_t bias_P_q20[9];

    uint16_t rest_count;
    uint16_t flags;
} fixed_vqf_t;

/* LSM6DSV selected gyro scale: raw sample -> rad/s Q7.24. */
q24_t fixed_vqf_gyro_raw_to_q24(int16_t raw);

void fixed_vqf_init(fixed_vqf_t *s);
void fixed_vqf_update_gyr(fixed_vqf_t *s, const q24_t gyr_rads_q24[3]);
void fixed_vqf_update_acc(fixed_vqf_t *s, const q30_t acc_g_q30[3]);
void fixed_vqf_get_q30(const fixed_vqf_t *s, q30_t out[4]);
void fixed_vqf_get_bias_q24(const fixed_vqf_t *s, q24_t out[3]);
void fixed_vqf_get_bias_q16(const fixed_vqf_t *s, int32_t out[3]);
bool fixed_vqf_get_rest_detected(const fixed_vqf_t *s);

