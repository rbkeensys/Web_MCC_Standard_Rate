// ADD THIS TO openWidgetSettings() function in app.js
// Around line 2520, after the pidpanel case

  if (w.type==='motor'){
    root.append(tableForm([
      ['Motor Index', inputNum(w.opts,'motorIndex',1)],
      ['Show Controls', inputChk(w.opts,'showControls')]
    ]));
  }
