// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use pretty_assertions::assert_eq;

const AUTH: &str = "https://space.example/oauth/authorize?response_type=code&client_id=c&state=S1&redirect_uri=http%3A%2F%2F127.0.0.1%3A41234%2Fcallback&code_challenge=x";

#[test]
fn this_logins_redirect_is_sent_to_its_listener() {
    let target = callback_target(AUTH, " http://127.0.0.1:41234/callback?code=abc&state=S1&iss=https%3A%2F%2Fspace.example\n")
        .expect("accepted");
    assert_eq!(
        target.as_str(),
        "http://127.0.0.1:41234/callback?code=abc&state=S1&iss=https%3A%2F%2Fspace.example"
    );
    // A browser that showed `localhost` is still this listener.
    assert!(callback_target(AUTH, "http://localhost:41234/callback?code=abc&state=S1").is_ok());
    // A provider error is delivered too, so the login fails with its reason.
    assert!(callback_target(AUTH, "http://127.0.0.1:41234/callback?error=access_denied&state=S1").is_ok());
}

#[test]
fn anything_else_is_refused_before_a_request_is_made() {
    for (pasted, why) in [
        ("not a url", "not a URL"),
        ("http://127.0.0.1:41234/callback?code=abc&state=OTHER", "different sign-in"),
        ("http://127.0.0.1:41234/callback?code=abc", "different sign-in"),
        ("http://127.0.0.1:9999/callback?code=abc&state=S1", "not this sign-in's redirect"),
        ("http://127.0.0.1:41234/admin?code=abc&state=S1", "not this sign-in's redirect"),
        ("http://evil.example:41234/callback?code=abc&state=S1", "not this sign-in's redirect"),
        ("https://127.0.0.1:41234/callback?code=abc&state=S1", "not this sign-in's redirect"),
        ("http://127.0.0.1:41234/callback?state=S1", "no code yet"),
    ] {
        let CallbackRejected(message) = callback_target(AUTH, pasted).expect_err(pasted);
        assert!(message.contains(why), "{pasted}: {message}");
    }
    let remote = "https://as.example/authorize?state=S1&redirect_uri=https%3A%2F%2Frabi.example%2Fcb";
    let CallbackRejected(message) =
        callback_target(remote, "https://rabi.example/cb?code=a&state=S1").expect_err("remote");
    assert!(message.contains("not on this machine"), "{message}");
}

#[tokio::test]
async fn delivery_is_the_request_the_browser_would_have_made() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept");
        let mut buf = vec![0u8; 1024];
        let n = socket.read(&mut buf).await.expect("read");
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
            .await
            .expect("write");
        String::from_utf8_lossy(&buf[..n]).into_owned()
    });
    let target = Url::parse(&format!("http://localhost:{port}/callback?code=abc&state=S1")).expect("url");
    assert_eq!(deliver(&target).await, Ok(200));
    let request = server.await.expect("server");
    assert!(
        request.starts_with("GET /callback?code=abc&state=S1 HTTP/1.1\r\n"),
        "{request}"
    );

    // Nothing listening any more: the login ended or timed out.
    let gone = Url::parse(&format!("http://127.0.0.1:{port}/callback?code=a&state=S1")).expect("url");
    let error = deliver(&gone).await.expect_err("closed");
    assert!(error.contains("no longer waiting"), "{error}");
}
