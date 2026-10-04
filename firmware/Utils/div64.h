#pragma once
#include <stdint.h>
/* Exact floor(n/d) for 1 <= d < 2^24 using only 32-bit DIVU/REMU, so no
 * libgcc __udivdi3/__umoddi3 is linked. Radix-256 long division: the
 * running remainder r < d < 2^24, hence (r<<8)|digit < 2^32 never
 * overflows and each quotient digit is < 256. Result is bit-identical to
 * the C expression n/d for every n. Header-only (static inline) so host
 * unit tests need no extra source; identical copies are folded by ICF. */
static inline uint64_t div64_u24(uint64_t n, uint32_t d)
{
    uint64_t q = 0U;
    uint32_t r = 0U;
    uint8_t k;
    for (k = 0U; k < 8U; ++k) {
        uint32_t cur = (r << 8) | (uint32_t)(n >> 56);
        n <<= 8;
        q = (q << 8) | (cur / d);
        r = cur % d;
    }
    return q;
}
