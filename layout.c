#include "User/fixed_vqf.h"
#include <stdio.h>
int main(){printf("%zu %zu %zu %zu\n",sizeof(fixed_vqf_t),(size_t)&((fixed_vqf_t*)0)->gyro_bias_q32,(size_t)&((fixed_vqf_t*)0)->bias_P_q20,(size_t)&((fixed_vqf_t*)0)->flags);}
