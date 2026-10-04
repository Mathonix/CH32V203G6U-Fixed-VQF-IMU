#pragma once
#include <stdint.h>
#include <stdbool.h>
/* Fixed-threshold, output-only AT32 profile-3 heading hold. Units: mdeg,
 * mdps^2, us. VQF integration and bias estimation remain untouched. */
typedef struct {
    int32_t offset_mdeg,held_mdeg;
    uint32_t rate2_lp,enter_us,exit_us;
    bool active;
} zaru_heading_hold_t;
extern zaru_heading_hold_t zaru_heading;
int32_t zaru_heading_update(int32_t yaw,uint32_t rate2,bool acc_ok,uint32_t dt,bool enabled);
