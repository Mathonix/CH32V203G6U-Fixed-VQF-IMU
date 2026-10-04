#pragma once
#include <stdint.h>
#include <stdbool.h>
#define ACC_CAL_STATUS_IDLE 0U
#define ACC_CAL_STATUS_RUNNING 1U
#define ACC_CAL_STATUS_DONE 2U
#define ACC_CAL_STATUS_FAILED 3U
typedef struct { float bias_g[3],scale[3]; uint8_t valid; } acc_calibration_t;
bool acc_params_valid(const acc_calibration_t *cal);
void acc_params_identity(acc_calibration_t *cal);
