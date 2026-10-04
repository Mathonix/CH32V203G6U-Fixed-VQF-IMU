#include "proto_codec.h"
uint16_t proto_crc16(const uint8_t *data,uint16_t length)
{
    uint16_t crc=0xFFFFU; uint8_t bit;
    while(length--) {
        crc^=(uint16_t)*data++<<8;
        for(bit=0;bit<8;bit++) crc=(uint16_t)((crc&0x8000U) ? ((uint32_t)crc<<1)^0x1021U : (uint32_t)crc<<1);
    }
    return crc;
}
