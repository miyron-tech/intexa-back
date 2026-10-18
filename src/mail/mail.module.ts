import { Module } from '@nestjs/common';
import { MailOutboxService } from './mail-outbox.service.js';

@Module({ providers: [MailOutboxService] })
export class MailModule {}
