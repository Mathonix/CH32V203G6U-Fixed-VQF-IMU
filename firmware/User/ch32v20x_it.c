/********************************** (C) COPYRIGHT *******************************
 * File Name          : ch32v20x_it.c
 * Author             : WCH
 * Version            : V1.0.0
 * Date               : 2023/12/29
 * Description        : Main Interrupt Service Routines.
*********************************************************************************
* Copyright (c) 2021 Nanjing Qinheng Microelectronics Co., Ltd.
* Attention: This software (modified or not) and binary are used for 
* microcontroller manufactured by Nanjing Qinheng Microelectronics.
*******************************************************************************/
#include "ch32v20x_it.h"
#include "../Services/time_service.h"
#include "fixed_vqf.h"

void NMI_Handler(void) __attribute__((interrupt("WCH-Interrupt-fast")));
void HardFault_Handler(void) __attribute__((interrupt("WCH-Interrupt-fast")));
void TIM2_IRQHandler(void) __attribute__((interrupt("WCH-Interrupt-fast")));

extern volatile uint8_t vqf_sample_pending;
extern volatile uint32_t vqf_timer_ticks;
extern volatile uint32_t vqf_missed_count;
/* Retained across software/watchdog reset, for debugger diagnosis. */
volatile struct {
    uint32_t magic,boots,faults,cause,pc,value,ticks,reset_flags;
} host_fault_trace __attribute__((section(".noinit")));
void host_trace_boot(void)
{
    if(host_fault_trace.magic!=0x41485232UL) {
        host_fault_trace.magic=0x41485232UL; host_fault_trace.boots=host_fault_trace.faults=0;
        host_fault_trace.cause=host_fault_trace.pc=host_fault_trace.value=host_fault_trace.ticks=0;
    }
    extern volatile uint32_t system_reset_flags;
    host_fault_trace.boots++; host_fault_trace.reset_flags=system_reset_flags;
}

/*********************************************************************
 * @fn      NMI_Handler
 *
 * @brief   This function handles NMI exception.
 *
 * @return  none
 */
void NMI_Handler(void)
{
  host_fault_trace.faults++;
  __asm volatile("csrr %0, mcause" : "=r"(host_fault_trace.cause));
  __asm volatile("csrr %0, mepc" : "=r"(host_fault_trace.pc));
  host_fault_trace.ticks=vqf_timer_ticks;
  NVIC_SystemReset();
  while (1)
  {
  }
}

/*********************************************************************
 * @fn      HardFault_Handler
 *
 * @brief   This function handles Hard Fault exception.
 *
 * @return  none
 */
void HardFault_Handler(void)
{
  host_fault_trace.faults++;
  __asm volatile("csrr %0, mcause" : "=r"(host_fault_trace.cause));
  __asm volatile("csrr %0, mepc" : "=r"(host_fault_trace.pc));
  __asm volatile("csrr %0, mtval" : "=r"(host_fault_trace.value));
  host_fault_trace.ticks=vqf_timer_ticks;
  NVIC_SystemReset();
  while (1)
  {
  }
}



void TIM2_IRQHandler(void)
{
    if(TIM_GetITStatus(TIM2, TIM_IT_Update) != RESET)
    {
        TIM_ClearITPendingBit(TIM2, TIM_IT_Update);
        vqf_timer_ticks++;
        time_service_tick((uint16_t)(1000000U / FIXED_VQF_SAMPLE_HZ));
        if(vqf_sample_pending != 0U) vqf_missed_count++;
        else vqf_sample_pending = 1U;
    }
}
