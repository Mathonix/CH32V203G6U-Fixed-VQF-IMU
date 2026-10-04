#pragma once
#include "ch32v20x.h"

#define BOARD_NAME "CH32V203G6U6"
#define DEVICE_MODEL_NAME "CH32_AHRS_6D"
#define FW_VERSION_MAJOR 1U
#define FW_VERSION_MINOR 0U
#define FW_VERSION_PATCH 0U
#define FW_BUILD_NUMBER 20261003UL
#define BOARD_HW_REVISION "UNSPECIFIED" /* TODO(HW): board revision / serial provisioning. */
#define BOARD_SERIAL "UNPROVISIONED"
#define HOST_TRANSPORT_UART 1
#define HOST_TRANSPORT_USB_CDC 0
#define HAS_MAGNETOMETER 0
#define HAS_BAROMETER 0
#define HAS_VOLTAGE_MONITOR 0
#ifndef ENABLE_SENSOR_MOCK
#ifdef SENSOR_MOCK_ENABLE
#define ENABLE_SENSOR_MOCK SENSOR_MOCK_ENABLE
#else
#define ENABLE_SENSOR_MOCK 0
#endif
#endif
#ifndef FW_VERSION_TEXT /* build_ahrs.py --fw-version overrides (OTA test images) */
#if ENABLE_SENSOR_MOCK
#define FW_VERSION_TEXT "20261003m"
#else
#define FW_VERSION_TEXT "20261003h" /* 9 chars, AA55 0x32 and app descriptor */
#endif
#endif
#define HOST_UART_BAUD_DEFAULT 2000000UL /* Explicit user requirement. */
#define HOST_UART_INTERFRAME_US 100U /* Leave WCH-Link CDC time between DMA frames. */
#define HOST_UART_RX_TURNAROUND_US 2000U
#define HOST_UART_CONTROL_GAP_US 2000U
#define HOST_UART USART2
#define HOST_UART_CLOCK RCC_APB1Periph_USART2
#define HOST_UART_IRQ USART2_IRQn
#define HOST_UART_GPIO GPIOA
#define HOST_UART_GPIO_CLOCK RCC_APB2Periph_GPIOA
#define HOST_UART_TX_PIN GPIO_Pin_2
#define HOST_UART_RX_PIN GPIO_Pin_3 /* User confirmed PA3 -> WCH-Link TX, 2026-10-03. */
#define HOST_UART_DMA DMA1_Channel7
#define HOST_UART_DMA_FLAG DMA1_FLAG_GL7
#define BOARD_IMU_CS_PORT GPIOA
#define BOARD_IMU_CS_PIN GPIO_Pin_4
#define HOST_RX_SIZE 1024U
#define HOST_HIGH_TX_SIZE 512U
#define HOST_NORMAL_TX_SIZE 256U
#define HOST_LOW_TX_SIZE 1024U
#define HOST_STREAM_RATE_DEFAULT 200U
#define HOST_STREAM_RATE_MAX 2000U
#define HOST_SENSOR_WARNING_US 20000UL
#define HOST_SENSOR_TIMEOUT_US 100000UL
