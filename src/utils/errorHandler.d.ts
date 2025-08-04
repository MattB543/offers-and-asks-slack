import { App } from '@slack/bolt';
export declare class ErrorHandler {
    private slackApp;
    setSlackApp(app: App): void;
    handle(error: any, context: string, metadata?: any): Promise<void>;
    notifyAdmin(message: string, blocks?: any[]): Promise<void>;
}
export declare const errorHandler: ErrorHandler;
//# sourceMappingURL=errorHandler.d.ts.map