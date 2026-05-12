/*
 * Local compatibility shim for microsoft/vscode main's vscode.proposed.chatProvider.d.ts.
 * The proposal currently references ChatLocation without including its declaring proposal.
 */

declare module 'vscode' {
	export enum ChatLocation {
		Panel = 1,
		Terminal = 2,
		Notebook = 3,
		Editor = 4,
	}
}
