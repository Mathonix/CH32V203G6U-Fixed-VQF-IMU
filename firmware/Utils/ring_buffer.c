#include "ring_buffer.h"
#define BARRIER() __asm__ volatile("" ::: "memory")
void ring_init(ring_buffer_t *r, uint8_t *data, uint16_t capacity)
{ r->data=data; r->capacity=capacity; r->head=0; r->tail=0; }
uint16_t ring_count(const ring_buffer_t *r) { return (uint16_t)(r->head-r->tail); }
uint16_t ring_free(const ring_buffer_t *r) { return r->capacity-ring_count(r); }
bool ring_push(ring_buffer_t *r, uint8_t byte)
{
    uint16_t head=r->head;
    if((uint16_t)(head-r->tail)>=r->capacity) return false;
    r->data[head & (r->capacity-1U)]=byte;
    BARRIER(); r->head=(uint16_t)(head+1U); return true;
}
bool ring_pop(ring_buffer_t *r, uint8_t *byte)
{
    uint16_t tail=r->tail;
    if(r->head==tail) return false;
    BARRIER(); *byte=r->data[tail & (r->capacity-1U)];
    BARRIER(); r->tail=(uint16_t)(tail+1U); return true;
}
