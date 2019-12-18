const express = require('express')
const sharp = require('sharp')
const fs = require('fs')
const fsp = fs.promises
const svgCaptcha = require('svg-captcha')
const session = require('express-session')
var md5 = require('md5')
const multer = require('multer')
const uploader = multer({
  dest: './upload/',
  preservePath: true
})

// 更改密码时，令牌和更改密码的用户之间的映射
const changePasswordTokenMap = {}
const app = express.Router()

app.route('/register')
  .get((req, res, next) => {
    res.render('regisiter.pug')
  })
  .post(uploader.single('avatar'), async (req, res, next) => {
    var regInfo = req.body
    console.log(regInfo, req.file)

    var imgBuf = await fsp.readFile(req.file.path)
    await sharp(imgBuf)
      .resize(200)
      .toFile(req.file.path)

    var userName = await db.get('SELECT * FROM users WHERE name = "' + regInfo.name + '"')
    var userEmail = await db.get('SELECT * FROM users WHERE email = "' + regInfo.email + '"')
    if (userName) {
      res.end('用户名已被注册')
    } if (userEmail) {
      res.end('邮箱已被注册')
    } else {
      // 下面等价上面一行，为上面一行的简写
      // db.run('INSERT INTO user (name, email, password) VALUES ('+regInfo.name+','+regInfo.email+','+regInfo.password+')')
      await db.run(
        // 存储文件的常规操作是  avatar 类存在users中
        // avarar 的详细信息单独在数据库中创建一个表格，将 id,name,originalname,path,size,mime 的信息存入
        // 这些信息如果不存入，系统读取文件时可能会出错
        // 这里只存图片，系统一般可以识别，为了...，就不单独创建一个表格了
        'INSERT INTO users (name, email, password, avatar) VALUES (?,?,?,?)',
        regInfo.name, regInfo.email, md5(md5(regInfo.password)), req.file.path
      )
      res.end('注册成功')
    }
  })

app.post('/login', async (req, res, next) => {
  var tryLogInfo = req.body
  if (tryLogInfo.captcha.toLowerCase() != req.session.captcha.toLowerCase()) {
    res.send('验证码错误')
  }
  var loginSec = await db.get('SELECT * FROM users WHERE name=? AND password=?',
    tryLogInfo.name, md5(md5(tryLogInfo.password))
  )
  if (loginSec) {
    res.cookie('userid', loginSec.id, {
      signed: true
    })
    res.redirect('/')
  } else {
    res.render('passwordWrong.pug')
  }
})

app.get('/logout', (req, res, next) => {
  // 退出登陆，清除cookie
  res.clearCookie('userid')
  res.redirect('/')
})

app.route('/forget')
  .get((req, res, next) => {
    res.end(`
      <form method="post" action="/forget">
        请输入您的邮箱：<input type="email" name="email" />
        <button>确定</button>
      </form>
    `)
  })
  .post(async (req, res, next) => {

    // 忘记密码的邮箱先与令牌（token）建立映射关系
    // token 是一个随机数，20分钟无操作需清除
    var email = req.body.email
    var token = Math.random().toString().slice(2)
    changePasswordTokenMap[token] = email

    setTimeout(() => {
      delete changePasswordTokenMap[token]
    }, 60 * 1000 * 20)
    if (await db.get('SELECT * FROM users WHERE email = ?', email)) {
      var link = `http://localhost:3008/changePassword/${token}`

      // 这里实际上是要向目标邮箱发送一个邮件的
      // 暂时用log代替
      console.log(link)

      res.end('已向您的邮箱发送重置链接，请于20分钟内操作')
    } else {
      res.end('请输入正确邮箱')
    }
  })

app.route('/changePassword/:token')
  .get(async (req, res, next) => {
    var token = req.params.token
    var email = changePasswordTokenMap[token]
    if (!email) {
      res.end('链接已失效')
      return
    }
    var user = await db.get('SELECT * FROM users WHERE email=?', changePasswordTokenMap[token])
    res.end(`
      <form method="post" action="">
        <h3>正在重置${user.name}用户密码</h3><br>
        <input type="password" name="password" />
        <button>确定</button>
      </form>
    `)
  })
  .post(async (req, res, next) => {
    var token = req.params.token
    var email = changePasswordTokenMap[token]
    if (!email) {
      res.end('链接已失效')
      return
    }
    await db.run('UPDATE users SET password=? WHERE email=?', md5(md5(req.body.password)), changePasswordTokenMap[token])
    // 重置密码后，令牌失效
    delete changePasswordTokenMap[token]
    res.end('密码重置成功')
  })

  app.get('/captcha', (req, res, next) => {
    var captcha = svgCaptcha.create({
      ignoreChars: '0o1il'
    })
    req.session.captcha = captcha.text
  
    res.type('svg')
    res.send(captcha.data)
  })

module.exports = app