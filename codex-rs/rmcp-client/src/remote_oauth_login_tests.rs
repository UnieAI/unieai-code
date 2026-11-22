use super::*;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use codex_exec_server::RouteAwareHttpClient;
use codex_http_client::ClientRouteClass;
use codex_http_client::HttpClientBuilder;
use codex_http_client::HttpClientFactory;
use codex_http_client::OutboundProxyPolicy;
use oauth2::TokenResponse;
use pretty_assertions::assert_eq;
use sha2::Digest;
use sha2::Sha256;
use std::sync::Mutex;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::Request;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path;

const SESSION: &str = "remote-session-1234567890";
const SECRET: &str = "device-secret-123456789012345678901234567890";

#[derive(Clone, Copy)]
enum Reply {
    Success,
    BadState,
    BadIssuer,
    MissingIssuer,
    Pending,
    Expired,
}

struct Fixture {
    relay: MockServer,
    provider: MockServer,
    client: codex_http_client::HttpClient,
    authorization: Arc<Mutex<Option<Url>>>,
}

impl Fixture {
    async fn new(reply: Reply, expires_in: u64) -> Result<Self> {
        let relay = MockServer::start().await;
        let provider = MockServer::start().await;
        let origin = relay.uri();
        let redirect = format!("{origin}{API_PATH}/callback");
        let authorization = Arc::new(Mutex::new(None::<Url>));
        Mock::given(method("POST"))
            .and(path(format!("{API_PATH}/start")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "session_id": SESSION, "device_secret": SECRET,
                "redirect_uri": redirect,
                "verification_uri": format!("{origin}{API_PATH}/authorize/{SESSION}"),
                "expires_in": expires_in, "interval": 1,
            })))
            .mount(&relay)
            .await;
        let captured = Arc::clone(&authorization);
        Mock::given(method("POST"))
            .and(path(format!("{API_PATH}/configure")))
            .respond_with(move |request: &Request| {
                let body: Value = request.body_json().unwrap();
                assert_eq!(body["device_secret"], SECRET);
                assert_eq!(body["session_id"], SESSION);
                let url = Url::parse(body["authorization_url"].as_str().unwrap()).unwrap();
                *captured.lock().unwrap() = Some(url);
                ResponseTemplate::new(200).set_body_json(json!({"ok":true}))
            })
            .mount(&relay)
            .await;
        let captured = Arc::clone(&authorization);
        let issuer = provider.uri();
        Mock::given(method("POST"))
            .and(path(format!("{API_PATH}/poll")))
            .respond_with(move |request: &Request| {
                let body: Value = request.body_json().unwrap();
                assert_eq!(body["device_secret"], SECRET);
                if matches!(reply, Reply::Expired) {
                    return ResponseTemplate::new(410);
                }
                if matches!(reply, Reply::Pending) {
                    return ResponseTemplate::new(200).set_body_json(json!({"status":"pending"}));
                }
                let auth = captured.lock().unwrap().clone().unwrap();
                let params: HashMap<_, _> = auth.query_pairs().into_owned().collect();
                let mut callback = Url::parse(&redirect).unwrap();
                callback
                    .query_pairs_mut()
                    .append_pair("code", "private-authorization-code")
                    .append_pair(
                        "state",
                        if matches!(reply, Reply::BadState) {
                            "wrong-state-secret"
                        } else {
                            &params["state"]
                        },
                    );
                if !matches!(reply, Reply::MissingIssuer) {
                    callback.query_pairs_mut().append_pair(
                        "iss",
                        if matches!(reply, Reply::BadIssuer) {
                            "https://wrong-issuer.example/private"
                        } else {
                            &issuer
                        },
                    );
                }
                ResponseTemplate::new(200)
                    .set_body_json(json!({"status":"callback","callback_url":callback.as_str()}))
            })
            .mount(&relay)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("{API_PATH}/complete")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok":true})))
            .mount(&relay)
            .await;
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-authorization-server"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "issuer": provider.uri(),
                "authorization_endpoint": format!("{}/authorize",provider.uri()),
                "token_endpoint": format!("{}/token",provider.uri()),
                "registration_endpoint": format!("{}/register",provider.uri()),
                "response_types_supported":["code"],
                "code_challenge_methods_supported":["S256"],
                "authorization_response_iss_parameter_supported":true,
                "token_endpoint_auth_methods_supported":["none"],
            })))
            .mount(&provider)
            .await;
        let redirect = format!("{origin}{API_PATH}/callback");
        let registration_redirect = redirect.clone();
        Mock::given(method("POST"))
            .and(path("/register"))
            .respond_with(move |request: &Request| {
                let body: Value = request.body_json().unwrap();
                assert_eq!(body["redirect_uris"], json!([registration_redirect]));
                ResponseTemplate::new(201).set_body_json(json!({
                    "client_id":"remote-client", "redirect_uris":[registration_redirect],
                    "token_endpoint_auth_method":"none",
                }))
            })
            .mount(&provider)
            .await;
        let captured = Arc::clone(&authorization);
        Mock::given(method("POST")).and(path("/token"))
            .respond_with(move |request: &Request| {
                let body: HashMap<_, _> = url::form_urlencoded::parse(&request.body).into_owned().collect();
                assert_eq!(body["redirect_uri"], redirect);
                assert_eq!(body["code"], "private-authorization-code");
                let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(body["code_verifier"].as_bytes()));
                let auth = captured.lock().unwrap().clone().unwrap();
                let params: HashMap<_,_> = auth.query_pairs().into_owned().collect();
                assert_eq!(params["code_challenge"], challenge);
                assert_eq!(params["code_challenge_method"], "S256");
                ResponseTemplate::new(200).set_body_json(json!({
                    "access_token":"remote-access-token", "refresh_token":"remote-refresh-token", "token_type":"Bearer",
                }))
            }).mount(&provider).await;
        let client = HttpClientBuilder::new()
            .without_redirects()
            .without_request_logging()
            .build_respecting_outbound_proxy_policy(
                &HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault),
                &relay.uri(),
                ClientRouteClass::Auth,
            )?;
        Ok(Self {
            relay,
            provider,
            client,
            authorization,
        })
    }

    async fn login(&self, cancel: impl Future<Output = ()>) -> Result<()> {
        perform_remote_oauth_login_with_cancel(
            "remote-test",
            &self.provider.uri(),
            OAuthCredentialsStoreMode::File,
            AuthKeyringBackendKind::Direct,
            Some(HashMap::from([(
                "x-mcp-secret".to_string(),
                "mcp-private-header".to_string(),
            )])),
            None,
            &[],
            None,
            McpOAuthClientRegistration::Auto,
            None,
            Arc::new(RouteAwareHttpClient::new(HttpClientFactory::new(
                OutboundProxyPolicy::ReqwestDefault,
            ))),
            &self.client,
            &self.relay.uri(),
            |url| {
                assert_eq!(
                    url,
                    format!("{}{API_PATH}/authorize/{SESSION}", self.relay.uri())
                )
            },
            cancel,
        )
        .await
    }

    async fn assert_completed(&self, ok: bool) {
        let requests = self.relay.received_requests().await.unwrap();
        let completion = requests
            .iter()
            .find(|req| req.url.path().ends_with("/complete"))
            .unwrap();
        let body: Value = completion.body_json().unwrap();
        assert_eq!(body["ok"], ok);
        for request in requests {
            assert!(request.headers.get("authorization").is_none());
            assert!(request.headers.get("cookie").is_none());
            assert!(request.headers.get("x-mcp-secret").is_none());
            let body = String::from_utf8_lossy(&request.body);
            assert!(!body.contains("remote-access-token"));
            assert!(!body.contains("remote-refresh-token"));
            assert!(!body.contains("code_verifier"));
        }
    }
}

#[tokio::test]
async fn remote_oauth_exchanges_pkce_locally_and_saves_existing_credential_key() -> Result<()> {
    // Existing shared guard serializes all credential-file tests in this crate.
    assert!(
        std::env::var_os("UNIEAI_HOME").is_none(),
        "run tests without UNIEAI_HOME"
    );
    let _home = crate::oauth::test_support::TempCodexHome::new();
    let fixture = Fixture::new(Reply::Success, 600).await?;
    fixture.login(std::future::pending()).await?;
    fixture.assert_completed(true).await;
    let stored = crate::stored_oauth_credentials(
        "remote-test",
        &fixture.provider.uri(),
        OAuthCredentialsStoreMode::File,
        AuthKeyringBackendKind::Direct,
    )?
    .context("credentials were not saved")?;
    assert_eq!(stored.client_id, "remote-client");
    assert_eq!(
        stored.token_response.0.access_token().secret(),
        "remote-access-token"
    );
    Ok(())
}

#[tokio::test]
async fn remote_oauth_rejects_wrong_state_or_issuer_before_token_exchange() -> Result<()> {
    for reply in [Reply::BadState, Reply::BadIssuer, Reply::MissingIssuer] {
        let fixture = Fixture::new(reply, 600).await?;
        let error = fixture.login(std::future::pending()).await.unwrap_err();
        let message = format!("{error:#}");
        assert!(!message.contains("private"));
        assert!(!message.contains("wrong-state-secret"));
        fixture.assert_completed(false).await;
        assert!(
            !fixture
                .provider
                .received_requests()
                .await
                .unwrap()
                .iter()
                .any(|req| req.url.path() == "/token")
        );
    }
    Ok(())
}

#[tokio::test]
async fn remote_oauth_cancellation_and_expiry_acknowledge_failure() -> Result<()> {
    for (reply, expires_in) in [
        (Reply::Pending, 600),
        (Reply::Pending, 1),
        (Reply::Expired, 600),
    ] {
        let fixture = Fixture::new(reply, expires_in).await?;
        let cancel = async {
            if expires_in == 600 && matches!(reply, Reply::Pending) {
                while fixture.authorization.lock().unwrap().is_none() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            } else {
                std::future::pending::<()>().await;
            }
        };
        assert!(fixture.login(cancel).await.is_err());
        fixture.assert_completed(false).await;
    }
    Ok(())
}

#[tokio::test]
async fn remote_oauth_retries_completion_after_lost_server_acknowledgement() -> Result<()> {
    assert!(
        std::env::var_os("UNIEAI_HOME").is_none(),
        "run tests without UNIEAI_HOME"
    );
    let _home = crate::oauth::test_support::TempCodexHome::new();
    let fixture = Fixture::new(Reply::Success, 600).await?;
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = Arc::clone(&attempts);
    Mock::given(method("POST"))
        .and(path(format!("{API_PATH}/complete")))
        .respond_with(move |_: &Request| {
            if observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                ResponseTemplate::new(503)
            } else {
                ResponseTemplate::new(200).set_body_json(json!({"ok": true}))
            }
        })
        .with_priority(1)
        .mount(&fixture.relay)
        .await;
    fixture.login(std::future::pending()).await?;
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    fixture.assert_completed(true).await;
    Ok(())
}

#[test]
fn remote_oauth_rejects_unsafe_origins_and_cross_origin_grants() {
    for origin in [
        "http://relay.example",
        "https://user:secret@relay.example",
        "https://relay.example/path",
        "https://relay.example?secret=1",
        "https://relay.example/#secret",
    ] {
        assert!(relay_origin(origin).is_err());
    }
    let origin = relay_origin("https://relay.example").unwrap();
    let mut grant = RemoteGrant {
        session_id: SESSION.to_string(),
        device_secret: SECRET.to_string(),
        redirect_uri: format!("https://relay.example{API_PATH}/callback"),
        verification_uri: format!("https://relay.example{API_PATH}/authorize/{SESSION}"),
        expires_in: 600,
        interval: 2,
    };
    grant.validate(&origin).unwrap();
    grant.redirect_uri = format!("https://attacker.example{API_PATH}/callback");
    assert!(grant.validate(&origin).is_err());
    grant.redirect_uri = format!("https://relay.example{API_PATH}/callback");
    grant.verification_uri = format!("https://attacker.example{API_PATH}/authorize/{SESSION}");
    assert!(grant.validate(&origin).is_err());
}

fn relay_client(relay: &MockServer) -> codex_http_client::HttpClient {
    HttpClientBuilder::new()
        .without_redirects()
        .without_request_logging()
        .build_respecting_outbound_proxy_policy(
            &HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault),
            &relay.uri(),
            ClientRouteClass::Auth,
        )
        .expect("relay client")
}

async fn mount_status(relay: &MockServer, endpoint: &str, status: u16) {
    Mock::given(method("POST"))
        .and(path(format!("{API_PATH}/{endpoint}")))
        .respond_with(ResponseTemplate::new(status))
        .mount(relay)
        .await;
}

#[tokio::test]
async fn remote_oauth_start_without_the_route_does_not_claim_expiry() {
    let relay = MockServer::start().await;
    mount_status(&relay, "start", 404).await;
    let origin = Url::parse(&relay.uri()).expect("relay origin");
    let error = post_json::<RemoteGrant>(&relay_client(&relay), &origin, "start", false, json!({}))
        .await
        .err()
        .expect("a relay without the route must fail");
    let message = error.to_string();
    assert!(message.contains("404"), "{message}");
    assert!(!message.to_lowercase().contains("expired"), "{message}");
}

#[tokio::test]
async fn remote_oauth_session_gone_endpoint_still_reports_expiry() {
    let relay = MockServer::start().await;
    mount_status(&relay, "poll", 410).await;
    let origin = Url::parse(&relay.uri()).expect("relay origin");
    let error = post_json::<PollResponse>(&relay_client(&relay), &origin, "poll", true, json!({}))
        .await
        .err()
        .expect("a gone session must fail");
    assert!(
        error.to_string().to_lowercase().contains("expired"),
        "{error}"
    );
}

#[tokio::test]
async fn remote_oauth_accepts_an_empty_acknowledgement_body() {
    let relay = MockServer::start().await;
    mount_status(&relay, "configure", 204).await;
    let origin = Url::parse(&relay.uri()).expect("relay origin");
    let client = relay_client(&relay);
    let acknowledged: Value = post_json(&client, &origin, "configure", true, json!({}))
        .await
        .expect("204 is a valid acknowledgement");
    assert_eq!(acknowledged, Value::Null);
    // A typed response still requires a body.
    assert!(
        post_json::<PollResponse>(&client, &origin, "configure", true, json!({}))
            .await
            .is_err()
    );
}
