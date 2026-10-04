#pragma once
#include "../Services/acc_six_face.h"
extern acc_six_face_t acc_cal_state;
void app_acc_cal_init(void);
void app_acc_cal_poll(void);
void app_acc_cal_start(uint8_t seq);
void app_acc_cal_cancel(void);
/* LED level for face n (= done faces + 1): n pulses in each 1 s, -1 when idle. */
int16_t app_acc_cal_led(uint16_t full);
