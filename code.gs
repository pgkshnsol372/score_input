// ==========================================
// 1. Webアプリのエントリーポイント (GET)
// ==========================================
function doGet(e) {
  if (e.parameter && e.parameter.type === 'roster') {
    return getRosterJSON(e.parameter.spreadsheetUrl);
  }

  var template = HtmlService.createTemplateFromFile('index');
  template.appUrl = ScriptApp.getService().getUrl();

  return template.evaluate()
      .setTitle('Baseball Score Input')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
}

// ==========================================
// 2. データ受信・処理のエントリーポイント (POST)
// ==========================================
function doPost(e) {
  try {
    var jsonString = e.postData.contents;
    var data = JSON.parse(jsonString);
    var ss = getSpreadsheet(data.spreadsheetUrl);

    if (data.action === 'register_player') {
      return registerNewPlayer(ss, data.name);
    }
    
    if (data.action === 'rename_player') {
      return renamePlayer(ss, data.oldName, data.newName);
    }

    if (data.action === 'save_game_data') {
      return saveGameData(ss, data);
    }

    return createJSONOutput({ status: "error", message: "Unknown action" });
    
  } catch (error) {
    return createJSONOutput({ status: "error", message: error.toString() });
  }
}

// ==========================================
// 3. ユーティリティ & データ処理
// ==========================================

function getSpreadsheet(url) {
  if (!url) throw new Error("スプレッドシートのURLが設定されていません。");
  try {
    return SpreadsheetApp.openByUrl(url);
  } catch (e) {
    throw new Error("シートにアクセスできません。共有設定を確認してください。");
  }
}

function getRosterJSON(url) {
  try {
    var ss = getSpreadsheet(url);
    var sheet = ss.getSheetByName('選手リスト');
    if (!sheet) return createJSONOutput([]);
    var lastRow = sheet.getLastRow();
    if (lastRow < 1) return createJSONOutput([]);
    var values = sheet.getRange(1, 1, lastRow, 1).getValues();
    var roster = values.flat().filter(function(name) { return name && name !== ""; });
    return createJSONOutput(roster);
  } catch (e) {
    return createJSONOutput({ error: e.toString(), roster: [] });
  }
}

function createJSONOutput(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// 4. データ保存ロジック
// ==========================================

function saveGameData(ss, data) {
  // 詳細ログ保存
  if (data.playLogs && data.playLogs.length > 0) {
    savePlayLog(ss, data.playLogs);
  }

  // スコアボード保存
  if (data.scoreBoard) {
    // イニング数情報がない場合はデフォルト9回とする
    var inningsCount = data.inningsCount || 9;
    saveScoreBoard(ss, data.gameInfo, data.scoreBoard, inningsCount);
  }

  return createJSONOutput({ status: "success", message: "Game data saved successfully" });
}

function savePlayLog(ss, logs) {
  var sheet = ss.getSheetByName('チーム集計');
  if (!sheet) {
    sheet = ss.insertSheet('チーム集計');
    sheet.appendRow(['ID', 'タイムスタンプ', '日付', '相手', 'P左右', '打順', '回', 'アウト', '走者', '打者', '結果', '詳細', '打点', '得点']);
  }
  
  var lastRow = sheet.getLastRow();
  var startRow = lastRow < 1 ? 2 : lastRow + 1;
  var rowsToAdd = logs.map(function(item) { return item.row || item; });

  if (rowsToAdd.length > 0) {
    sheet.getRange(startRow, 1, rowsToAdd.length, rowsToAdd[0].length).setValues(rowsToAdd);
  }
}

function saveScoreBoard(ss, gameInfo, scoreBoard, inningsCount) {
  var sheet = ss.getSheetByName('スコア集計');
  
  // ヘッダー行の定義（A列:攻撃回, B列:得点 を追加）
  var header = ['攻撃回', '得点', '日付', 'チーム名', '1', '2', '3', '4', '5', '6', '7', '8', '9', '計', '先攻/後攻'];

  if (!sheet) {
    sheet = ss.insertSheet('スコア集計');
    sheet.appendRow(header);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(header);
  }

  // 行データを作成する内部関数
  var createRowData = function(teamData, role) {
    var scores = [];
    var attackInnings = 0;

    // 1回から9回までループ
    for (var i = 1; i <= 9; i++) {
      if (i > inningsCount) {
        // 設定されたイニング数より後は空欄
        scores.push("");
      } else {
        // 値取得 (undefinedや空文字なら0、それ以外は入力値)
        var val = teamData[i];
        if (val === undefined || val === "") val = 0;
        
        scores.push(val);

        // 攻撃イニング数のカウント ('x' または 'X' 以外をカウント)
        if (String(val).toLowerCase() !== 'x') {
          attackInnings++;
        }
      }
    }

    // 自チームでない場合はA列・B列を空欄にする
    var displayAttackInnings = teamData.isMe ? attackInnings : "";
    var displayTotalScore = teamData.isMe ? teamData.total : "";

    return [
      displayAttackInnings,    // A列: 攻撃したイニング数 (自チームのみ)
      displayTotalScore,       // B列: 合計得点 (自チームのみ)
      gameInfo.date,           // C列: 日付
      teamData.name,           // D列: チーム名
      scores[0], scores[1], scores[2], scores[3], scores[4], scores[5], scores[6], scores[7], scores[8], // 1~9回
      teamData.total,          // 計
      role                     // 先攻/後攻
    ];
  };

  // 先攻・後攻それぞれの行を追加
  sheet.appendRow(createRowData(scoreBoard.top, "先攻"));
  sheet.appendRow(createRowData(scoreBoard.bottom, "後攻"));
}

// ==========================================
// 5. 選手管理ロジック
// ==========================================

function registerNewPlayer(ss, name) {
  var listSheet = ss.getSheetByName('選手リスト');
  if (!listSheet) { listSheet = ss.insertSheet('選手リスト'); }
  
  var lastRow = listSheet.getLastRow();
  var exists = false;
  if (lastRow > 0) {
    var existingNames = listSheet.getRange(1, 1, lastRow, 1).getValues().flat();
    if (existingNames.indexOf(name) !== -1) exists = true;
  }
  if (!exists) listSheet.appendRow([name]);

  var teamSheet = ss.getSheetByName('チーム成績');
  if (teamSheet && teamSheet.getLastRow() >= 11) {
    teamSheet.insertRowAfter(11);
    var sourceRange = teamSheet.getRange(11, 1, 1, teamSheet.getLastColumn());
    sourceRange.copyTo(teamSheet.getRange(12, 1));
    teamSheet.getRange(12, 1).setValue(name);
  }
  
  if (!ss.getSheetByName(name)) {
    var templateSheet = ss.getSheetByName('個人集計シート');
    if (templateSheet) {
      var newSheet = templateSheet.copyTo(ss);
      newSheet.setName(name);
      newSheet.getRange("A1").setValue(name);
    }
  }
  return createJSONOutput({ status: "success", message: "Registered" });
}

function renamePlayer(ss, oldName, newName) {
  var listSheet = ss.getSheetByName('選手リスト');
  if (listSheet) {
    var finder = listSheet.createTextFinder(oldName).matchEntireCell(true);
    finder.replaceAllWith(newName);
  }
  var teamSheet = ss.getSheetByName('チーム成績');
  if (teamSheet) {
    var rangeA = teamSheet.getRange("A:A");
    var finderTeam = rangeA.createTextFinder(oldName).matchEntireCell(true);
    finderTeam.replaceAllWith(newName);
  }
  var personalSheet = ss.getSheetByName(oldName);
  if (personalSheet) {
    personalSheet.setName(newName);
    personalSheet.getRange("A1").setValue(newName);
  }
  return createJSONOutput({ status: "success", message: "Renamed" });
}
