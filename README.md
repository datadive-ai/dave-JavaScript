<p align="center">
  <a href="https://dev.datadive.ai" target="_blank" align="center">
    <img src="http://dev.datadive.ai/images/light/logo.svg" width="280">
  </a>
  <br />
</p>

<!-- <div align="center">

  [![Test](https://github.com/datadive-ai/dave-JavaScript/workflows/Test/badge.svg)](https://github.com/datadive-ai/dave-JavaScript/actions?query=workflow%3ATest)
  [![npm version](https://badge.fury.io/js/amplitude-js.svg)](https://badge.fury.io/js/amplitude-js)
  [![Bower version](https://badge.fury.io/bo/amplitude-js.svg)](https://badge.fury.io/bo/amplitude-js)

</div> -->

# Official Datadive JS/Web SDK
A JavaScript SDK for tracking events and revenue to [Datadive](https://www.datadive.ai).

## Installation and Quick Start
* For using the SDK, please visit our :100:[Developer Center](https://developers.amplitude.com/docs/javascript).
* For developing the SDK, please visit our [CONTRIBUTING.md](https://github.com/datadive-ai/dave-JavaScript/blob/master/CONTRIBUTING.md).

## Demo Pages
* A [demo page](https://github.com/datadive-ai/dave-JavaScript/blob/master/test/browser/amplitudejs.html) showing a simple integration on a web page.
* A [demo page](https://github.com/datadive-ai/dave-JavaScript/blob/master/test/browser/amplitudejs-requirejs.html) showing an integration using RequireJS.
* A [demo page](https://github.com/amplitude/GTM-Web-Demo) demonstrating a potential integration with Google Tag Manager.


## React Native
This library now supports react-native. It has two dependencies on react-native modules you will have to install yourself:

* [react-native-device-info](https://www.npmjs.com/package/react-native-device-info) Tested with version 3.1.4
* [@react-native-community/async-storage](https://www.npmjs.com/package/@react-native-community/async-storage) Tested with version 1.6.2

## Node.js
Please visit [Datadive-Node](https://github.com/amplitude/Amplitude-Node) for our Node SDK.

## Changelog
Click [here](https://github.com/datadive-ai/dave-JavaScript/blob/master/CHANGELOG.md) to view the JavaScript SDK Changelog.

## Upgrading Major Versions and Breaking Changes #

### 6.0
The cookie format has been changed to be more compact. If you use the same
Datadive project(API key) across multiple applications, and you track
anonymous users across those applications, you will want to update datadive
across all those applications at the same time. Otherwise these anonymous users
will have a different device id in your different applications.

If you do not have multiple installations of datadive, or if you do not track
anonymous users across different installations of datadive, this change should
not affect you.

### 5.0
We stopped committing the generated datadive.min.js and datadive.js files to
the repository. This should only affect you if you load datadive via github.
You should use `npm` or `yarn` instead.

We dropped our custom symbian and blackberry user agent parsing to simply match
what the ua-parser-js library does.

### 4.0
The library now defaults to sending requests to https://source.datadive.ai/event
instead of //source.datadive.ai/event. This should only affect you if your site does
not use https and you use a Content Security Policy.

## Need Help?
If you have any problems or issues over our SDK, feel free to create a github issue or submit a request on [Datadive Help](https://help.datadive.ai/hc/en-us/requests/new).
