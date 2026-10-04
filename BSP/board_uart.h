#pragma once
#include <stdbool.h>
#include <stdint.h>
void board_uart_init(uint32_t baud);
bool board_uart_read(uint8_t *byte);
bool board_uart_idle(void);
void board_uart_send(const uint8_t *data, uint16_t length);
uint32_t board_uart_rx_bytes(void);
uint32_t board_uart_rx_errors(void);
