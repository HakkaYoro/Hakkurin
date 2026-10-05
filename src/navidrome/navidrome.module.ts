import { Module } from '@nestjs/common';
import { NavidromeAdapter } from './infrastructure/navidrome.adapter';

@Module({
  providers: [NavidromeAdapter],
  exports: [NavidromeAdapter],
})
export class NavidromeModule {}
