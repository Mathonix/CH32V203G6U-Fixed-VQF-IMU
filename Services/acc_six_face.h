#ifndef ACC_SIX_FACE_H
#define ACC_SIX_FACE_H
#include "acc_params.h"
#include "acc_cal_limits.h"

/* Face bits and indices: -X, +X, -Y, +Y, -Z, +Z. Inputs are nominal
 * sensor-frame g and temperature/bias-corrected gyro deg/s, before filtering. */
#define ACC_CAL_STATUS_CANCELLED 4U
#define ACC_CAL_PHASE_WAITING 0U
#define ACC_CAL_PHASE_STABLE 1U
#define ACC_CAL_PHASE_SAMPLING 2U
#define ACC_CAL_PHASE_SAVING 3U
#define ACC_CAL_PHASE_COMPLETE 4U
#define ACC_CAL_PHASE_MOVING 5U
#define ACC_CAL_PHASE_DUPLICATE 6U
#define ACC_CAL_PHASE_FAILED 7U

typedef struct {
  uint8_t active, face, face_mask, candidate, phase, status;
  uint16_t error, progress;
  uint32_t start_ms, face_start_ms, stable_ms, collect_ms, last_sample_ms, end_ms, samples;
  float mean[3], m2[3], last_g[3], raw_g[3], face_mean[6][3];
  acc_calibration_t result;
} acc_six_face_t;

void acc_six_face_start(acc_six_face_t *state, uint32_t now_ms);
void acc_six_face_cancel(acc_six_face_t *state);
void acc_six_face_tick(acc_six_face_t *state, uint32_t now_ms);
/* Returns 1 exactly when all six poses pass and result is ready to save. */
int acc_six_face_push(acc_six_face_t *state, uint32_t now_ms,
                      const float raw_g[3], const float gyro_dps[3]);
void acc_six_face_saved(acc_six_face_t *state, int save_result);
#endif
