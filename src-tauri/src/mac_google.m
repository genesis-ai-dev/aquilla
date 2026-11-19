#import <AuthenticationServices/AuthenticationServices.h>
#import <AppKit/AppKit.h>

@interface AquillaGooglePresentation : NSObject <ASWebAuthenticationPresentationContextProviding>
@property(nonatomic, strong) NSWindow *window;
@end
@implementation AquillaGooglePresentation
- (ASPresentationAnchor)presentationAnchorForWebAuthenticationSession:(ASWebAuthenticationSession *)session {
    return self.window;
}
@end

// Main-thread only. The completion block retains the presentation provider.
static ASWebAuthenticationSession *activeSession;
static NSString *activeAttempt;
typedef void (*GoogleCompletion)(void *, const char *, bool);

void aquilla_google_begin(void *window, const char *url, const char *attempt, bool privateSession,
                         void *context, GoogleCompletion finish) {
    if (activeSession) {
        finish(context, NULL, false);
        return;
    }
    AquillaGooglePresentation *presentation = [AquillaGooglePresentation new];
    presentation.window = (__bridge NSWindow *)window;
    activeAttempt = [NSString stringWithUTF8String:attempt];
    __block BOOL completed = NO;
    activeSession = [[ASWebAuthenticationSession alloc]
        initWithURL:[NSURL URLWithString:[NSString stringWithUTF8String:url]]
        callbackURLScheme:@"aquilla"
        completionHandler:^(NSURL *callback, NSError *error) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (completed) return;
                completed = YES;
                activeSession = nil;
                activeAttempt = nil;
                [presentation.window makeKeyAndOrderFront:nil];
                finish(context, callback.absoluteString.UTF8String,
                       [error.domain isEqualToString:ASWebAuthenticationSessionErrorDomain] &&
                       error.code == ASWebAuthenticationSessionErrorCodeCanceledLogin);
            });
        }];
    activeSession.prefersEphemeralWebBrowserSession = privateSession;
    activeSession.presentationContextProvider = presentation;
    if (![activeSession start]) {
        completed = YES;
        activeSession = nil;
        activeAttempt = nil;
        finish(context, NULL, false);
    }
}

void aquilla_google_cancel(const char *attempt) {
    if ([activeAttempt isEqualToString:[NSString stringWithUTF8String:attempt]]) {
        [activeSession cancel];
    }
}
