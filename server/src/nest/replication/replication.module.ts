import { Module } from '@nestjs/common';
import { ReplicationController } from './replication.controller';
import { ReplicationService } from './replication.service';

@Module({
  controllers: [ReplicationController],
  providers: [ReplicationService],
})
export class ReplicationModule {}
