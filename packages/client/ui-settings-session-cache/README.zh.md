---
description: "设置浏览器会话历史缓存的单会话上限和页面总上限。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-session-cache

[English](README.md) | 中文

## 概述

在**插件**中打开**会话历史缓存**，设置浏览器为非活动会话保留多少历史。本机和远端会话共享页面总上限。保存后，已经打开且有权读取设置的页面也会更新。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

**单会话上限（MiB）**限制单个会话的缓存历史和阅读位置占用的容量。**页面总上限（MiB）**限制一个浏览器页面的缓存总容量。两个字段都接受正整数，清空字段并保存即可恢复部署默认值。保存失败时，表单会保留修改供你检查。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

浏览器端监听共享的 `session-controller` 设置，并将已接受的完整预算交给当前页面的 Session Controller。插件页的 slot 拥有编辑器及其草稿。编辑器需要设置读取权限，操作控件还要求文档可写且用户拥有修改权限。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Session Controller](../../api/session-controller/README.zh.md)说明缓存行为。
- [插件页](../ui-plugin-manager/README.zh.md)说明内置配置卡片。
- [共享设置](../ui-settings/README.zh.md)说明浏览器读取的已接受设置及写入队列。

-----

<a id="model-experience"></a>
## 模型体验

无，本包只设置浏览器对非活动会话的历史缓存上限。

#### KV 缓存影响

无。缓存内容是浏览器里的会话历史和阅读位置。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **设置读取权限**。浏览器在首次读到有效配置前使用 Session Controller 的初始上限。设置之后无法读取时，页面保留最后一次生效的预算。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
