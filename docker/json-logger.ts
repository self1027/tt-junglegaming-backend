import { ConsoleLogger, Logger } from '@nestjs/common';

Logger.overrideLogger(new ConsoleLogger({ json: true, colors: false }));
