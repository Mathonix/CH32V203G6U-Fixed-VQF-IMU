#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Check the integer address range before doing any address arithmetic. */
static inline bool heap_adjust(uintptr_t current, uintptr_t begin,
                               uintptr_t end, ptrdiff_t increment,
                               uintptr_t *next)
{
    if(current < begin || current > end) return false;
    if(increment >= 0) {
        uintptr_t amount = (uintptr_t)increment;
        if(amount > end - current) return false;
        *next = current + amount;
    } else {
        uintptr_t amount = (increment == PTRDIFF_MIN) ?
                           ((uintptr_t)PTRDIFF_MAX + 1U) :
                           (uintptr_t)(-increment);
        if(amount > current - begin) return false;
        *next = current - amount;
    }
    return true;
}
