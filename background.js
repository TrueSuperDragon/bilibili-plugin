const PANEL_PATH = "popup.html";
const REFERER_RULE_ID = 1001;

async function ensureBilibiliRefererRule() {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return;
  const rule = {
    id: REFERER_RULE_ID,
    priority: 100,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        {
          header: "referer",
          operation: "set",
          value: "https://www.bilibili.com/"
        },
        {
          header: "origin",
          operation: "set",
          value: "https://www.bilibili.com"
        }
      ]
    },
    condition: {
      requestDomains: ["bilivideo.com", "bilivideo.cn"],
      resourceTypes: ["xmlhttprequest", "media", "other"]
    }
  };

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [REFERER_RULE_ID],
      addRules: [rule]
    });
  } catch (error) {
    // Keep extension usable even if DNR rule setup fails.
    console.warn("Failed to configure DNR referer rule:", error);
  }
}

async function openSidePanel(tabId) {
  if (!chrome.sidePanel?.open) return false;
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: PANEL_PATH,
      enabled: true
    });
    await chrome.sidePanel.open({ tabId });
    return true;
  } catch (error) {
    return false;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureBilibiliRefererRule();
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureBilibiliRefererRule();
});

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab?.id;
  if (tabId && (await openSidePanel(tabId))) {
    return;
  }
  chrome.tabs.create({ url: chrome.runtime.getURL(PANEL_PATH) });
});
