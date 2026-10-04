/* Adapted from Mathonix/AT32F423_LSM6DSV @ 156968d50d114ee7e961f4eb03f2d66b50471355.
 * Portable state machine; CH32 Flash and fixed-point application are separate. */
#include "acc_six_face.h"
#include "acc_six_face.h"
#include <math.h>
#include <string.h>

/* Fit only calls sqrt on finite values near one. Newton iteration avoids
 * newlib's sqrtf wrapper pulling double-precision exception handling into
 * the 32KB image. Six iterations resolve these inputs to float precision. */
static float cal_sqrt(float x)
{ unsigned i; float y=1.0f; for(i=0;i<6;i++) y=0.5f*(y+x/y); return y; }

static void reset_candidate(acc_six_face_t *s, uint8_t phase)
{
  s->candidate = 0U; s->samples = 0U; s->progress = 0U;
  s->stable_ms = 0U; s->collect_ms = 0U; s->phase = phase;
  memset(s->mean, 0, sizeof(s->mean)); memset(s->m2, 0, sizeof(s->m2));
}

static void fail(acc_six_face_t *s, uint16_t error)
{
  s->active = 0U; s->status = ACC_CAL_STATUS_FAILED;
  s->end_ms = s->last_sample_ms;
  s->phase = ACC_CAL_PHASE_FAILED; s->error = error;
}

void acc_six_face_start(acc_six_face_t *s, uint32_t now_ms)
{
  memset(s, 0, sizeof(*s)); s->active = 1U;
  s->status = ACC_CAL_STATUS_RUNNING; s->start_ms = now_ms;
  s->face_start_ms = now_ms; s->last_sample_ms = now_ms;
}

void acc_six_face_cancel(acc_six_face_t *s)
{
  if(!s->active) return;
  s->active = 0U; s->status = ACC_CAL_STATUS_CANCELLED;
  s->end_ms = s->last_sample_ms;
  reset_candidate(s, ACC_CAL_PHASE_WAITING); s->error = 0x0608U;
}

void acc_six_face_tick(acc_six_face_t *s, uint32_t now_ms)
{
  if(s->active && (uint32_t)(now_ms - s->face_start_ms) >=
     (uint32_t)(APP_ACC_CAL_FACE_TIMEOUT_S * 1000.0f)) {
    fail(s, 0x0603U); s->end_ms = now_ms;
  }
}

static int detect_face(const float a[3], const float g[3])
{
  unsigned k, axis = 0; float norm2 = 0.0f;
  for(k = 0; k < 3; ++k) {
    if(!isfinite(a[k]) || !isfinite(g[k]) || fabsf(g[k]) > APP_ACC_CAL_GYR_REST_DPS) return -1;
    norm2 += a[k] * a[k];
    if(fabsf(a[k]) > fabsf(a[axis])) axis = k;
  }
  if(norm2 < (1.0f-APP_ACC_CAL_NORM_TOL_G)*(1.0f-APP_ACC_CAL_NORM_TOL_G) ||
     norm2 > (1.0f+APP_ACC_CAL_NORM_TOL_G)*(1.0f+APP_ACC_CAL_NORM_TOL_G) ||
     fabsf(a[axis]) < APP_ACC_CAL_DOMINANT_MIN_G) return -1;
  for(k = 0; k < 3; ++k) if(k != axis && fabsf(a[k]) > APP_ACC_CAL_OTHER_MAX_G) return -1;
  return (int)(axis*2U + (a[axis] >= 0.0f));
}

static float corrected_off_axis2(const acc_six_face_t *s, unsigned face)
{
  unsigned k; float sum = 0.0f;
  for(k = 0; k < 3; ++k) if(k != face/2) {
    float c = (s->face_mean[face][k]-s->result.bias_g[k])*s->result.scale[k];
    sum += c*c;
  }
  return sum;
}

/* Axis-aligned ellipsoid fit: bias/scale such that every face mean has a
 * corrected magnitude of exactly 1 g. Hand placement tilts gravity away from
 * the nominal axis but never changes its magnitude, so each face's off-axis
 * part is folded into its dominant-axis target sqrt(1 - off^2) instead of
 * being rejected as error. Untilted faces reduce to the classic
 * bias=(P+N)/2, scale=2/(P-N). The fixed point contracts by roughly
 * off-axis^2 per pass, so eight passes reach float precision. */
static int fit(acc_six_face_t *s)
{
  float *bias = s->result.bias_g, *scale = s->result.scale, target[6];
  unsigned axis, face, pass;
  for(face = 0; face < 6; ++face) target[face] = 1.0f;
  for(pass = 0; pass < 8U; ++pass) {
    for(axis = 0; axis < 3; ++axis) {
      float pos = s->face_mean[axis*2+1][axis], neg = s->face_mean[axis*2][axis];
      float tp = target[axis*2+1], tn = target[axis*2];
      if(!(pos-neg >= 1.5f)) return 0;
      scale[axis] = (tp+tn)/(pos-neg);
      bias[axis] = (tn*pos+tp*neg)/(tp+tn);
      if(!isfinite(bias[axis]) || !isfinite(scale[axis])) return 0;
    }
    for(face = 0; face < 6; ++face) {
      float off2 = corrected_off_axis2(s, face);
      /* Numerical guard only; per-face detection already bounds the tilt. */
      if(!(off2 <= APP_ACC_CAL_MAX_TILT_G*APP_ACC_CAL_MAX_TILT_G)) return 0;
      target[face] = cal_sqrt(1.0f-off2);
    }
  }
  for(axis = 0; axis < 3; ++axis)
    if(fabsf(bias[axis]) > APP_ACC_CAL_MAX_BIAS_G ||
       scale[axis] < APP_ACC_CAL_MIN_SCALE || scale[axis] > APP_ACC_CAL_MAX_SCALE) return 0;
  /* Convergence check: every corrected face must sit on the unit sphere. */
  for(face = 0; face < 6; ++face) {
    float dominant = (s->face_mean[face][face/2]-bias[face/2])*scale[face/2];
    float norm = cal_sqrt(dominant*dominant+corrected_off_axis2(s, face));
    if(!(fabsf(norm-1.0f) <= APP_ACC_CAL_MAX_NORM_ERR_G)) return 0;
  }
  s->result.valid = 1U; return 1;
}

int acc_six_face_push(acc_six_face_t *s, uint32_t now_ms, const float a[3], const float g[3])
{
  unsigned i; int dir;
  if(!s->active || s->phase == ACC_CAL_PHASE_SAVING) return 0;
  acc_six_face_tick(s, now_ms); if(!s->active) return 0;
  if((uint32_t)(now_ms-s->last_sample_ms) > APP_ACC_CAL_MAX_SAMPLE_GAP_MS)
    reset_candidate(s, ACC_CAL_PHASE_MOVING);
  s->last_sample_ms = now_ms;
  for(i = 0; i < 3; ++i) s->raw_g[i] = isfinite(a[i]) ? a[i] : 0.0f;
  dir = detect_face(a, g);
  if(dir < 0) { reset_candidate(s, ACC_CAL_PHASE_MOVING); return 0; }
  if(s->face_mask & (1U << dir)) { reset_candidate(s, ACC_CAL_PHASE_DUPLICATE); return 0; }
  if(s->candidate) for(i = 0; i < 3; ++i) if(fabsf(a[i]-s->last_g[i]) > APP_ACC_CAL_MAX_STEP_G) {
    reset_candidate(s, ACC_CAL_PHASE_MOVING); break;
  }
  memcpy(s->last_g, a, sizeof(s->last_g));
  if(s->candidate != (uint8_t)(dir+1)) {
    reset_candidate(s, ACC_CAL_PHASE_STABLE); s->candidate = (uint8_t)(dir+1);
    s->stable_ms = now_ms; return 0;
  }
  if((uint32_t)(now_ms-s->stable_ms) < APP_ACC_CAL_STABLE_MS) {
    s->progress = (uint16_t)((now_ms-s->stable_ms)*1000U/APP_ACC_CAL_STABLE_MS);
    return 0;
  }
  if(s->phase != ACC_CAL_PHASE_SAMPLING) { s->phase = ACC_CAL_PHASE_SAMPLING; s->collect_ms = now_ms; }
  ++s->samples;
  for(i = 0; i < 3; ++i) {
    float delta = a[i]-s->mean[i]; s->mean[i] += delta/(float)s->samples;
    s->m2[i] += delta*(a[i]-s->mean[i]);
  }
  { uint32_t p=(now_ms-s->collect_ms); s->progress=(uint16_t)(p>1000U ? 1000U : p); }
  if((uint32_t)(now_ms-s->collect_ms) < (uint32_t)(APP_ACC_CAL_FACE_SECONDS*1000.0f)) return 0;
  if(s->samples < 50U) { fail(s, 0x0605U); return 0; }
  for(i = 0; i < 3; ++i) if(s->m2[i]/(float)(s->samples-1U) > APP_ACC_CAL_MAX_STDDEV_G*APP_ACC_CAL_MAX_STDDEV_G) {
    reset_candidate(s, ACC_CAL_PHASE_MOVING); return 0;
  }
  memcpy(s->face_mean[dir], s->mean, sizeof(s->mean));
  s->face_mask |= (uint8_t)(1U << dir); ++s->face; s->face_start_ms = now_ms;
  reset_candidate(s, ACC_CAL_PHASE_WAITING);
  if(s->face != 6U) return 0;
  if(!fit(s)) { fail(s, 0x0606U); return 0; }
  s->phase = ACC_CAL_PHASE_SAVING; return 1;
}

void acc_six_face_saved(acc_six_face_t *s, int result)
{
  if(result != 0) { fail(s, result == -4 ? 0x0609U : 0x0607U); return; }
  s->active = 0U; s->status = ACC_CAL_STATUS_DONE;
  s->end_ms = s->last_sample_ms;
  s->phase = ACC_CAL_PHASE_COMPLETE; s->progress = 1000U; s->error = 0U;
}
