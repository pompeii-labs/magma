export enum LogLevel {
    DEBUG = 'DEBUG',
    INFO = 'INFO',
    WARN = 'WARN',
    ERROR = 'ERROR',
}

export enum ANSI {
    RESET = '\u001b[0m',
    BOLD = '\u001b[1m',
    // Colors
    RED = '\u001b[31m',
    GREEN = '\u001b[32m',
    YELLOW = '\u001b[33m',
    BLUE = '\u001b[34m',
    CYAN = '\u001b[36m',
    WHITE = '\u001b[37m',
    MAGENTA = '\u001b[95m',
}

export interface MagmaLogger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string | Error): void;
}

export class Logger implements MagmaLogger {
    private name: string;

    static main = new Logger('Magma');

    constructor(name: string) {
        this.name = name;
    }

    debug(message: string) {
        this.log(LogLevel.DEBUG, message);
    }

    info(message: string) {
        this.log(LogLevel.INFO, message);
    }

    warn(message: string) {
        this.log(LogLevel.WARN, message);
    }

    error(message: string | Error) {
        if (message instanceof Error) {
            this.log(LogLevel.ERROR, message.message);
        } else {
            this.log(LogLevel.ERROR, message);
        }
    }

    private log(level: LogLevel, message: string) {
        const logString = `[${this.name}]${this.getColor(level)}[${level}]${this.getColor()} ${message}`;

        if (logString) console.log(logString);
    }

    private getColor(level?: LogLevel): string {
        switch (level) {
            case LogLevel.INFO:
                return ANSI.CYAN;
            case LogLevel.DEBUG:
                return ANSI.WHITE;
            case LogLevel.WARN:
                return ANSI.YELLOW;
            case LogLevel.ERROR:
                return ANSI.RED;
            default:
                return ANSI.RESET;
        }
    }
}
