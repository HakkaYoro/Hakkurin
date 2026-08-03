import { Module } from '@nestjs/common';
import { NavidromeService } from './navidrome.service';
import { ConfigModule } from '../common/config.module';

@Module({
  imports: [ConfigModule],
  providers: [NavidromeService],
  exports: [NavidromeService],
})
export class NavidromeModule {}
