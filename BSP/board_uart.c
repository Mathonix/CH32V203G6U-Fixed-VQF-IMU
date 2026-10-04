#include "board_config.h"
#include "board_uart.h"
static uint8_t rx_storage[HOST_RX_SIZE];
static volatile uint32_t rx_wraps,rx_errors;
static uint32_t rx_tail,rx_bytes;
void DMA1_Channel6_IRQHandler(void) __attribute__((interrupt("WCH-Interrupt-fast")));
void DMA1_Channel6_IRQHandler(void)
{
    if(DMA_GetITStatus(DMA1_IT_TC6)!=RESET) {
        DMA_ClearITPendingBit(DMA1_IT_TC6); rx_wraps+=HOST_RX_SIZE;
    }
}
void board_uart_init(uint32_t baud)
{
    GPIO_InitTypeDef gpio={0}; USART_InitTypeDef uart={0};
    DMA_InitTypeDef dma={0}; NVIC_InitTypeDef nvic={0};
    rx_wraps=rx_tail=rx_bytes=rx_errors=0;
    RCC_APB2PeriphClockCmd(HOST_UART_GPIO_CLOCK,ENABLE);
    RCC_APB1PeriphClockCmd(HOST_UART_CLOCK,ENABLE);
    RCC_AHBPeriphClockCmd(RCC_AHBPeriph_DMA1,ENABLE);
    gpio.GPIO_Pin=HOST_UART_TX_PIN; gpio.GPIO_Speed=GPIO_Speed_50MHz;
    gpio.GPIO_Mode=GPIO_Mode_AF_PP; GPIO_Init(HOST_UART_GPIO,&gpio);
    gpio.GPIO_Pin=HOST_UART_RX_PIN; gpio.GPIO_Mode=GPIO_Mode_IPU;
    GPIO_Init(HOST_UART_GPIO,&gpio);
    uart.USART_BaudRate=baud; uart.USART_WordLength=USART_WordLength_8b;
    uart.USART_StopBits=USART_StopBits_1; uart.USART_Parity=USART_Parity_No;
    uart.USART_HardwareFlowControl=USART_HardwareFlowControl_None;
    uart.USART_Mode=USART_Mode_Tx|USART_Mode_Rx;
    USART_Init(HOST_UART,&uart); USART_Cmd(HOST_UART,ENABLE);
    DMA_DeInit(HOST_UART_DMA);
    dma.DMA_PeripheralBaseAddr=(uint32_t)&HOST_UART->DATAR;
    dma.DMA_DIR=DMA_DIR_PeripheralDST; dma.DMA_MemoryInc=DMA_MemoryInc_Enable;
    dma.DMA_PeripheralDataSize=DMA_PeripheralDataSize_Byte;
    dma.DMA_MemoryDataSize=DMA_MemoryDataSize_Byte;
    dma.DMA_Mode=DMA_Mode_Normal; dma.DMA_Priority=DMA_Priority_High;
    DMA_Init(HOST_UART_DMA,&dma); DMA_SetCurrDataCounter(HOST_UART_DMA,0);
    USART_DMACmd(HOST_UART,USART_DMAReq_Tx,ENABLE);
    DMA_DeInit(DMA1_Channel6);
    dma.DMA_DIR=DMA_DIR_PeripheralSRC; dma.DMA_MemoryBaseAddr=(uint32_t)rx_storage;
    dma.DMA_BufferSize=HOST_RX_SIZE; dma.DMA_Mode=DMA_Mode_Circular;
    dma.DMA_Priority=DMA_Priority_VeryHigh;
    DMA_Init(DMA1_Channel6,&dma); DMA_ITConfig(DMA1_Channel6,DMA_IT_TC,ENABLE);
    USART_DMACmd(HOST_UART,USART_DMAReq_Rx,ENABLE); DMA_Cmd(DMA1_Channel6,ENABLE);
    nvic.NVIC_IRQChannel=DMA1_Channel6_IRQn; nvic.NVIC_IRQChannelPreemptionPriority=0;
    nvic.NVIC_IRQChannelSubPriority=1; nvic.NVIC_IRQChannelCmd=ENABLE;
    NVIC_Init(&nvic);
}
bool board_uart_read(uint8_t *byte)
{
    uint32_t irq,head,remain,wraps;
    uint16_t status=HOST_UART->STATR;
    if(status&(USART_STATR_ORE|USART_STATR_NE|USART_STATR_FE|USART_STATR_PE)) {
        (void)HOST_UART->DATAR; rx_errors++;
    }
    __asm volatile("csrrc %0, 0x800, %1" : "=r"(irq) : "r"(8U) : "memory");
    wraps=rx_wraps; remain=DMA_GetCurrDataCounter(DMA1_Channel6);
    if(DMA_GetFlagStatus(DMA1_FLAG_TC6)!=RESET) {
        wraps+=HOST_RX_SIZE;
        remain=DMA_GetCurrDataCounter(DMA1_Channel6);
    }
    head=wraps+((HOST_RX_SIZE-remain)&(HOST_RX_SIZE-1U)); rx_bytes=head;
    if((uint32_t)(head-rx_tail)>HOST_RX_SIZE) { rx_errors++; rx_tail=head-HOST_RX_SIZE; }
    if(irq&8U) __asm volatile("csrs 0x800, %0" :: "r"(8U) : "memory");
    if(head==rx_tail) return false;
    *byte=rx_storage[rx_tail&(HOST_RX_SIZE-1U)]; rx_tail++; return true;
}
bool board_uart_idle(void)
{ return DMA_GetCurrDataCounter(HOST_UART_DMA)==0 && USART_GetFlagStatus(HOST_UART,USART_FLAG_TC)!=RESET; }
void board_uart_send(const uint8_t *data, uint16_t length)
{
    DMA_Cmd(HOST_UART_DMA,DISABLE); DMA_ClearFlag(HOST_UART_DMA_FLAG);
    HOST_UART_DMA->MADDR=(uint32_t)data;
    DMA_SetCurrDataCounter(HOST_UART_DMA,length); DMA_Cmd(HOST_UART_DMA,ENABLE);
}
uint32_t board_uart_rx_bytes(void) { return rx_bytes; }
uint32_t board_uart_rx_errors(void) { return rx_errors; }
