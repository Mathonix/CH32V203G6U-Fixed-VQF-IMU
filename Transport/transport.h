#pragma once
#include <stdint.h>
#include <stdbool.h>
typedef struct {
    int (*init)(void); int (*open)(void); void (*close)(void);
    int (*write)(const uint8_t *,uint16_t); void (*poll)(void);
    uint16_t (*tx_free)(void);
} transport_if_t;
enum { TX_HIGH, TX_NORMAL, TX_LOW };
extern const transport_if_t transport_uart;
extern uint32_t transport_tx_bytes, transport_tx_frames, transport_tx_drops;
bool transport_read(uint8_t *byte);
bool transport_send(const uint8_t *frame,uint16_t length,uint8_t priority);
bool transport_command_room(void);
void transport_discard_telemetry(void);
bool transport_idle(void);
