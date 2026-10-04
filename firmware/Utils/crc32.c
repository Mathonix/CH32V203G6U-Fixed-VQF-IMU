#include "crc32.h"
/* Bitwise (no table) to keep both the 1 KB boot stub and the app small. */
uint32_t crc32_update(uint32_t crc, const volatile uint8_t *p, uint32_t n)
{
    crc = ~crc;
    while(n--) {
        crc ^= *p++;
        for(int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xEDB88320UL & (0U - (crc & 1U)));
    }
    return ~crc;
}
