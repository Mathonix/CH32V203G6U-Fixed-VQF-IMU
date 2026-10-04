#include "transport.h"
#include "../BSP/board_uart.h"
#include "../BSP/board_config.h"
#include "../Utils/ring_buffer.h"
#include "../Protocol/proto_defs.h"
#include "../Services/time_service.h"
static uint8_t high[HOST_HIGH_TX_SIZE], normal[HOST_NORMAL_TX_SIZE], low[HOST_LOW_TX_SIZE];
static uint8_t active_frame[PROTO_MAX_FRAME];
static ring_buffer_t queue[3];
static bool opened;
static uint32_t next_tx_us;
uint32_t transport_tx_bytes,transport_tx_frames,transport_tx_drops;
extern volatile uint32_t uart_tx_frame_count,uart_tx_dma_busy_count;
static int uart_init(void)
{
    ring_init(&queue[0],high,sizeof(high)); ring_init(&queue[1],normal,sizeof(normal));
    ring_init(&queue[2],low,sizeof(low)); board_uart_init(HOST_UART_BAUD_DEFAULT);
    transport_tx_bytes=transport_tx_frames=transport_tx_drops=0; next_tx_us=time_us(); opened=true; return 0;
}
static int uart_open(void) { opened=true; return 0; }
static void uart_close(void) { opened=false; }
bool transport_read(uint8_t *byte)
{
    if(!opened || !board_uart_read(byte)) return false;
    /* WCH-Link's USB-to-UART transaction must settle before an immediate
     * short reply. Keep receive/service work live while deferring DMA start. */
    next_tx_us=time_us()+HOST_UART_RX_TURNAROUND_US; return true;
}
bool transport_send(const uint8_t *frame,uint16_t length,uint8_t priority)
{
    uint16_t i; ring_buffer_t *q;
    if(priority>TX_LOW || length>PROTO_MAX_FRAME || length==0) return false;
    q=&queue[priority];
    if(!opened || ring_free(q)<length+2U) { transport_tx_drops++; uart_tx_dma_busy_count=transport_tx_drops; return false; }
    /* Only the main loop owns TX queues; the DMA reads active_frame only. */
    ring_push(q,(uint8_t)length); ring_push(q,(uint8_t)(length>>8));
    for(i=0;i<length;i++) ring_push(q,frame[i]);
    return true;
}
static int uart_write(const uint8_t *data,uint16_t len)
{ return transport_send(data,len,TX_LOW) ? (int)len : -1; }
static uint16_t uart_free(void) { return ring_free(&queue[TX_LOW]); }
bool transport_command_room(void) { return ring_free(&queue[TX_HIGH])>=110U; }
bool transport_idle(void)
{ return board_uart_idle() && !ring_count(&queue[0]) && !ring_count(&queue[1]) && !ring_count(&queue[2]); }
void transport_discard_telemetry(void)
{
    uint8_t a,b,d; uint16_t len;
    while(ring_pop(&queue[TX_LOW],&a)) {
        ring_pop(&queue[TX_LOW],&b); len=(uint16_t)(a|((uint16_t)b<<8));
        while(len--) ring_pop(&queue[TX_LOW],&d);
    }
}
static void uart_poll(void)
{
    uint8_t p,a=0,b=0; uint16_t n,i;
    if(!opened || !board_uart_idle() || (int32_t)(time_us()-next_tx_us)<0) return;
    for(p=TX_HIGH;p<=TX_LOW;p++) {
        if(!ring_pop(&queue[p],&a)) continue;
        ring_pop(&queue[p],&b); n=(uint16_t)(a|((uint16_t)b<<8));
        for(i=0;i<n;i++) ring_pop(&queue[p],&active_frame[i]);
        next_tx_us=time_us()+((uint32_t)n*10000000UL/HOST_UART_BAUD_DEFAULT)+
                   (p==TX_HIGH ? HOST_UART_CONTROL_GAP_US : HOST_UART_INTERFRAME_US);
        board_uart_send(active_frame,n); transport_tx_bytes+=n; transport_tx_frames++;
        uart_tx_frame_count=transport_tx_frames; return;
    }
}
const transport_if_t transport_uart={uart_init,uart_open,uart_close,uart_write,uart_poll,uart_free};
