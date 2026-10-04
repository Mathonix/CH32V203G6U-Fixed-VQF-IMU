#pragma once
#include <stdint.h>
#include <stdbool.h>
/* Single producer / single consumer; capacity is a power of two, <=32768.
 * Aligned 16-bit loads/stores are atomic on the target. No dynamic allocation. */
typedef struct {
    uint8_t *data;
    uint16_t capacity;
    volatile uint16_t head, tail;
} ring_buffer_t;
void ring_init(ring_buffer_t *r, uint8_t *data, uint16_t capacity);
uint16_t ring_count(const ring_buffer_t *r);
uint16_t ring_free(const ring_buffer_t *r);
bool ring_push(ring_buffer_t *r, uint8_t byte);
bool ring_pop(ring_buffer_t *r, uint8_t *byte);
