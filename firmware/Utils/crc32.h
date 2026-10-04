#pragma once
#include <stdint.h>
/* IEEE 802.3 / zlib CRC32, chainable: crc32_update(0,..) == zlib.crc32(..). */
uint32_t crc32_update(uint32_t crc, const volatile uint8_t *p, uint32_t n);
