import { Module } from '@nestjs/common';
import { NavidromeService } from './infrastructure/navidrome.service';

@Module({
  providers: [NavidromeService],
  exports: [NavidromeService],
})
export class NavidromeModule {}
