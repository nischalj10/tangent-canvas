import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {transformWithOxc} from 'vite';

// Exercise the production component itself. Only the CSS import is omitted in
// this DOM-free check; hidden Electron tests verify its composed presentation.
const source=await fs.readFile(new URL('../src/SteeringNotice.jsx',import.meta.url),'utf8');
let {code}=await transformWithOxc(source,'SteeringNotice.jsx',{jsx:{runtime:'automatic'}});
code=code.replace(/import\s*["']\.\/steering-notice\.css["'];?/,'');
for(const name of ['react/jsx-runtime','lucide-react','react'])code=code.replaceAll(`"${name}"`,`"${import.meta.resolve(name)}"`).replaceAll(`'${name}'`,`'${import.meta.resolve(name)}'`);
const {default:SteeringNotice}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const render=status=>renderToStaticMarkup(React.createElement(SteeringNotice,{message:{id:'test-update',delivery:'steer',deliveryStatus:status}}));

test('accepted steering stays an ordinary user bubble without a misleading persistent banner',()=>{
  assert.equal(render('sent'),'');
  assert.equal(render('accepted'),'');
  assert.equal(renderToStaticMarkup(React.createElement(SteeringNotice,{message:{id:'ordinary'}})),'');
});

test('in-flight steering exposes accessible pending status without claiming delivery',()=>{
  const markup=render('sending');assert.match(markup,/role="status"/);assert.match(markup,/Sending…/);assert.match(markup,/aria-live="polite"/);assert.doesNotMatch(markup,/Steered|Received|Delivered/);
});

test('rejected and uncertain steering have distinct honest recovery states without blind retry',()=>{
  const rejected=render('failed'),uncertain=render('uncertain');assert.match(rejected,/role="alert"/);assert.match(rejected,/Not sent/);assert.doesNotMatch(rejected,/Steered|Delivered/);
  assert.match(uncertain,/role="alert"/);assert.match(uncertain,/Delivery unconfirmed/);assert.match(uncertain,/Check the conversation before sending again/);assert.doesNotMatch(uncertain,/<button/);
});
