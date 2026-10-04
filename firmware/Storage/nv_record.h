#pragma once
#include "nv_config.h"
#define NV_RECORD_BYTES 48U
bool nv_record_decode(const uint8_t *bytes,nv_config_t *config,uint32_t *sequence);
void nv_record_encode(uint8_t *bytes,const nv_config_t *config,uint32_t sequence);
bool nv_config_equal(const nv_config_t *a,const nv_config_t *b);
