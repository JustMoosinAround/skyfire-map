package com.skyfire.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * SkyFire for Android: the SkyFire web app (the public map) full screen, without a browser bar.
 * Map and forecast updates arrive through the website, so the app itself rarely needs updating.
 * Links to other sites (the Contact page, credits) open in the phone's browser.
 */
public class MainActivity extends Activity {
    static final String HOME = "https://justmoosinaround.github.io/skyfire-map/";
    static final String HOST = "justmoosinaround.github.io";
    static final String PATH = "/skyfire-map/";
    WebView web;
    View fullView;
    WebChromeClient.CustomViewCallback fullCallback;
    WebChromeClient chrome;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " SkyFireApp/1");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                boolean ours = HOST.equals(u.getHost()) && u.getPath() != null && u.getPath().startsWith(PATH);
                if (ours) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* no browser */ }
                return true;
            }
        });
        chrome = new WebChromeClient() {
            // The page's full-screen button (element full screen): show it over everything.
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullView != null) { callback.onCustomViewHidden(); return; }
                fullView = view; fullCallback = callback;
                ((android.widget.FrameLayout) getWindow().getDecorView()).addView(view);
                immersive(true);
            }
            @Override
            public void onHideCustomView() {
                if (fullView == null) return;
                ((android.widget.FrameLayout) getWindow().getDecorView()).removeView(fullView);
                fullView = null;
                if (fullCallback != null) fullCallback.onCustomViewHidden();
                fullCallback = null;
                immersive(false);
            }
        };
        web.setWebChromeClient(chrome);
        if (saved != null) web.restoreState(saved);
        else web.loadUrl(HOME);
    }

    void immersive(boolean on) {
        Window w = getWindow();
        w.getDecorView().setSystemUiVisibility(on
            ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            : View.SYSTEM_UI_FLAG_VISIBLE);
    }

    @Override
    public void onBackPressed() {
        if (fullView != null) { chrome.onHideCustomView(); return; }
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }
}
