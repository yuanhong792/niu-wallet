// One-off maintenance script: add the personal multichain labels introduced by the
// one-coin-one-card layout to all six locale catalogs.
// Kept in tools/ so the exact wording is reproducible instead of hand-edited JSON.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const entries={
  '一个币一张卡：余额、收款地址、二维码、转出都在自己的卡里，互不干扰。':{
    'zh-CN':'一个币一张卡：余额、收款地址、二维码、转出都在自己的卡里，互不干扰。',
    en:'One coin per card: balance, receive address, QR code and transfers stay in their own card.',
    ja:'1コイン1カード：残高、受取アドレス、QRコード、送金はすべて各自のカード内にまとまります。',
    ko:'코인 하나당 카드 하나: 잔액, 받는 주소, QR 코드, 전송이 각자의 카드 안에 있습니다.',
    es:'Una moneda por tarjeta: saldo, dirección de recepción, código QR y envíos en su propia tarjeta.',
    ru:'Одна монета — одна карточка: баланс, адрес, QR-код и переводы в своей карточке.'
  },
  '先创建并备份个人钱包，再使用卡片上的专属收款地址。':{
    'zh-CN':'先创建并备份个人钱包，再使用卡片上的专属收款地址。',
    en:'Create and back up the personal wallet first, then use the dedicated receive address on each card.',
    ja:'先に個人ウォレットを作成してバックアップし、各カードの専用受取アドレスを使用してください。',
    ko:'먼저 개인 지갑을 만들고 백업한 뒤, 각 카드의 전용 받는 주소를 사용하세요.',
    es:'Cree y respalde primero la cartera personal y luego use la dirección de recepción de cada tarjeta.',
    ru:'Сначала создайте и сохраните личный кошелёк, затем используйте адрес из карточки.'
  },
  '口令只在本机使用':{
    'zh-CN':'口令只在本机使用',
    en:'The password never leaves this computer',
    ja:'パスワードはこの端末内だけで使われます',
    ko:'비밀번호는 이 컴퓨터에서만 사용됩니다',
    es:'La contraseña solo se usa en este equipo',
    ru:'Пароль используется только на этом компьютере'
  },
  '口令用于加密此处的 BTC 与 EVM 私钥，忘记口令无法找回。导出的备份文件同样用这个口令加密，可在全新数据目录恢复；已有账户时拒绝覆盖。':{
    'zh-CN':'口令用于加密此处的 BTC 与 EVM 私钥，忘记口令无法找回。导出的备份文件同样用这个口令加密，可在全新数据目录恢复；已有账户时拒绝覆盖。',
    en:'The password encrypts the BTC and EVM keys here and cannot be recovered if forgotten. The exported backup uses the same password and can be restored into a fresh data directory; an existing account is never overwritten.',
    ja:'パスワードはここの BTC と EVM の秘密鍵を暗号化し、忘れると復元できません。書き出したバックアップも同じパスワードで暗号化され、新しいデータディレクトリで復元できます。既存のアカウントは上書きされません。',
    ko:'비밀번호는 이곳의 BTC 및 EVM 개인키를 암호화하며 잊으면 복구할 수 없습니다. 내보낸 백업도 같은 비밀번호로 암호화되고 새 데이터 폴더에서 복원할 수 있습니다. 기존 계정은 덮어쓰지 않습니다.',
    es:'La contraseña cifra las claves BTC y EVM de este equipo y no se puede recuperar. La copia exportada usa la misma contraseña y puede restaurarse en un directorio nuevo; nunca se sobrescribe una cuenta existente.',
    ru:'Пароль шифрует ключи BTC и EVM; забытый пароль восстановить нельзя. Экспортированная копия шифруется тем же паролем и восстанавливается в новый каталог данных; существующий аккаунт не перезаписывается.'
  },
  '原有 NIU 账户与这里的个人账户分开备份，互不影响。':{
    'zh-CN':'原有 NIU 账户与这里的个人账户分开备份，互不影响。',
    en:'The original NIU account and this personal account are backed up separately and do not affect each other.',
    ja:'元の NIU アカウントとここの個人アカウントは別々にバックアップされ、互いに影響しません。',
    ko:'기존 NIU 계정과 이 개인 계정은 따로 백업되며 서로 영향을 주지 않습니다.',
    es:'La cuenta NIU original y esta cuenta personal se respaldan por separado y no se afectan.',
    ru:'Исходный аккаунт NIU и этот личный аккаунт резервируются отдельно и не влияют друг на друга.'
  },
  '余额需手动刷新；刷新会把该网络的收款地址发给对应的节点服务商。':{
    'zh-CN':'余额需手动刷新；刷新会把该网络的收款地址发给对应的节点服务商。',
    en:'Balances refresh on demand; refreshing sends that network address to its node provider.',
    ja:'残高は手動更新です。更新するとそのネットワークのアドレスがノード提供元に送信されます。',
    ko:'잔액은 수동으로 새로 고칩니다. 새로 고치면 해당 네트워크 주소가 노드 제공자에게 전송됩니다.',
    es:'Los saldos se actualizan manualmente; al hacerlo se envía la dirección de esa red al proveedor del nodo.',
    ru:'Баланс обновляется вручную; при обновлении адрес этой сети отправляется поставщику узла.'
  },
  '刷新全部余额':{
    'zh-CN':'刷新全部余额',
    en:'Refresh all balances',
    ja:'すべての残高を更新',
    ko:'모든 잔액 새로 고침',
    es:'Actualizar todos los saldos',
    ru:'Обновить все балансы'
  },
  '主网 · 真实资产':{
    'zh-CN':'主网 · 真实资产',
    en:'Mainnet · real funds',
    ja:'メインネット · 実際の資産',
    ko:'메인넷 · 실제 자산',
    es:'Red principal · fondos reales',
    ru:'Основная сеть · реальные средства'
  },
  '测试网 · 测试币没有实际价值':{
    'zh-CN':'测试网 · 测试币没有实际价值',
    en:'Testnet · test coins have no value',
    ja:'テストネット · テストコインに価値はありません',
    ko:'테스트넷 · 테스트 코인은 가치가 없습니다',
    es:'Red de prueba · las monedas de prueba no valen nada',
    ru:'Тестовая сеть · тестовые монеты не имеют ценности'
  },
  '测试网 · 测试币':{
    'zh-CN':'测试网 · 测试币',
    en:'Testnet · test coins',
    ja:'テストネット · テストコイン',
    ko:'테스트넷 · 테스트 코인',
    es:'Red de prueba · monedas de prueba',
    ru:'Тестовая сеть · тестовые монеты'
  },
  '主网与测试网切换':{
    'zh-CN':'主网与测试网切换',
    en:'Switch between mainnet and testnet',
    ja:'メインネットとテストネットの切り替え',
    ko:'메인넷과 테스트넷 전환',
    es:'Cambiar entre red principal y red de prueba',
    ru:'Переключение между основной и тестовой сетью'
  },
  '余额需手动刷新；刷新会把该网络的收款地址发给对应的节点服务商。测试网币没有价值，可先在这里练手。':{
    'zh-CN':'余额需手动刷新；刷新会把该网络的收款地址发给对应的节点服务商。测试网币没有价值，可先在这里练手。',
    en:'Balances refresh on demand; refreshing sends that network address to its node provider. Testnet coins have no value, so practise here first.',
    ja:'残高は手動更新です。更新するとそのネットワークのアドレスがノード提供元に送信されます。テストコインに価値はないので、まずここで練習してください。',
    ko:'잔액은 수동으로 새로 고칩니다. 새로 고치면 해당 네트워크 주소가 노드 제공자에게 전송됩니다. 테스트 코인은 가치가 없으니 여기서 먼저 연습하세요.',
    es:'Los saldos se actualizan manualmente; al hacerlo se envía la dirección de esa red al proveedor del nodo. Las monedas de prueba no valen nada: practique aquí primero.',
    ru:'Баланс обновляется вручную; при обновлении адрес этой сети отправляется поставщику узла. Тестовые монеты не имеют ценности — тренируйтесь здесь.'
  },
  '入账以网络余额与链上记录为准；私钥不会离开本机。':{
    'zh-CN':'入账以网络余额与链上记录为准；私钥不会离开本机。',
    en:'Incoming funds follow the on-chain balance and records; private keys never leave this computer.',
    ja:'入金はネットワーク残高とオンチェーン記録が基準です。秘密鍵は端末外に出ません。',
    ko:'입금은 네트워크 잔액과 온체인 기록을 기준으로 합니다. 개인키는 이 컴퓨터를 떠나지 않습니다.',
    es:'Los ingresos se rigen por el saldo y los registros en cadena; las claves privadas nunca salen del equipo.',
    ru:'Поступления определяются балансом и записями в сети; приватные ключи не покидают компьютер.'
  },
  '这里记录本机发起的交易；广播结果未知时不要重复转账。':{
    'zh-CN':'这里记录本机发起的交易；广播结果未知时不要重复转账。',
    en:'This lists transfers started on this computer; do not resend while a broadcast result is unknown.',
    ja:'ここにはこの端末で開始した取引が記録されます。ブロードキャスト結果が不明なときは再送しないでください。',
    ko:'이 컴퓨터에서 시작한 거래가 기록됩니다. 브로드캐스트 결과가 불확실할 때는 다시 보내지 마세요.',
    es:'Aquí se registran los envíos iniciados en este equipo; no reenvíe si el resultado de la difusión es desconocido.',
    ru:'Здесь записаны переводы, начатые на этом компьютере; не отправляйте повторно, если результат трансляции неизвестен.'
  }
};

// Labels that the tabbed layout replaced; dropping them keeps the catalogs honest.
const retired=[
  '测试网 · 测试币没有实际价值',
  '余额需手动刷新；刷新会把该网络的收款地址发给对应的节点服务商。'
];

for(const code of ['zh-CN','en','ja','ko','es','ru']){
  const file=resolve(root,'assets','locales',code+'.json');
  const catalog=JSON.parse(readFileSync(file,'utf8'));
  let added=0,removed=0;
  for(const key of retired){if(typeof catalog[key]==='string'){delete catalog[key];removed++;}}
  for(const [key,values] of Object.entries(entries)){
    if(typeof catalog[key]==='string')continue;
    catalog[key]=values[code];
    added++;
  }
  writeFileSync(file,JSON.stringify(catalog,null,2)+'\n');
  console.log(code,'added',added,'removed',removed);
}
