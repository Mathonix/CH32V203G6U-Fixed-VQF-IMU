#pragma once
#define FAST_CODE  __attribute__((section(".fasttext"), noinline))
#define SLOW_CODE  __attribute__((section(".slowtext"), noinline))
#define SLOW_RODATA __attribute__((section(".slowrodata")))
#define USED       __attribute__((used))
