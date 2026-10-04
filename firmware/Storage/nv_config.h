#pragma once
#include "../Protocol/proto_defs.h"
#include "../Services/acc_params.h"
typedef struct {
    uint16_t output_hz;
    output_config_t uart;
    uint8_t filter_profile;
    acc_calibration_t acc;
} nv_config_t;
extern nv_config_t nv_saved;
extern uint32_t nv_sequence,nv_write_errors;
void nv_config_load(void);
bool nv_config_save(const nv_config_t *config);
